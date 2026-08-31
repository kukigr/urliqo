import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import cors from 'cors';
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

function logMessage(message, data = null) {
  if (data) console.log(message, data);
  else console.log(message);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'pl,en-US;q=0.7,en;q=0.3'
};

app.post('/api/parse-event', async (req, res) => {
  try {
    let { url } = req.body;
    logMessage(`Otrzymano żądanie dla URL: ${url}`);

    if (!url) {
      return res.status(400).json({ error: 'Nie podano adresu URL.' });
    }

    let cleanUrl = url;
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.hostname.includes('facebook.com')) {
        parsedUrl.hostname = 'mbasic.facebook.com';
        cleanUrl = parsedUrl.toString();
      }
    } catch (e) {
      logMessage('Nie udało się sparsować URL do wyczyszczenia');
    }

    let extractedText = '';

    // Metoda 1: Pobieranie bezpośrednie z mbasic
    try {
      logMessage('Pobieranie bezpośrednie strony...');
      const directRes = await axios.get(cleanUrl, {
        headers: BROWSER_HEADERS,
        timeout: 8000
      });

      if (directRes.data && typeof directRes.data === 'string' && directRes.data.length > 200) {
        extractedText = directRes.data;
        logMessage('Sukces: Pobrano treść bezpośrednio.');
      }
    } catch (e) {
      logMessage('Pobieranie bezpośrednie nie powiodło się:', e.message);
    }

    // Metoda 2: Jina Reader (zapasowa)
    if (!extractedText || extractedText.length < 200) {
      try {
        logMessage('Pobieranie przez Jina Reader...');
        const headers = {
          ...BROWSER_HEADERS,
          'X-With-Generated-Alt': 'true',
          'X-No-Cache': 'true'
        };

        if (process.env.JINA_API_KEY) {
          headers['Authorization'] = `Bearer ${process.env.JINA_API_KEY}`;
        }

        const jinaRes = await axios.get(`https://r.jina.ai/${url}`, {
          headers,
          timeout: 10000
        });

        if (jinaRes.data && typeof jinaRes.data === 'string' && jinaRes.data.length > 100) {
          extractedText = jinaRes.data;
          logMessage('Sukces: Pobrano treść przez Jina Reader.');
        }
      } catch (e) {
        logMessage('Jina Reader zgłosił błąd/timeout:', e.message);
      }
    }

    if (extractedText) {
      extractedText = extractedText
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
        .replace(/<[^>]+>/g, '\n')
        .replace(/\n\s*\n/g, '\n');
    }

    if (!extractedText || extractedText.trim().length < 50) {
      logMessage('BŁĄD: Brak treści do analizy.');
      return res.status(422).json({ 
        error: 'Strona zablokowana lub brak treści',
        details: 'Nie udało się pobrać treści wydarzenia.'
      });
    }

    const schema = {
      type: SchemaType.OBJECT,
      properties: {
        title: { type: SchemaType.STRING, description: 'Nazwa wydarzenia' },
        description: { type: SchemaType.STRING, description: 'Podsumowanie lub opisu wydarzenia' },
        location: { type: SchemaType.STRING, description: 'Pełny adres lub nazwa miejsca i miasto' },
        source_url: { type: SchemaType.STRING, description: 'Link źródłowy' },
        days: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              day_number: { type: SchemaType.INTEGER },
              start_time_utc: { type: SchemaType.STRING, description: 'Data i godzina rozpoczęcia UTC w formacie ISO' },
              end_time_utc: { type: SchemaType.STRING, description: 'Data i godzina zakończenia UTC w formacie ISO' }
            },
            required: ['day_number', 'start_time_utc', 'end_time_utc']
          }
        }
      },
      required: ['title', 'description', 'location', 'source_url', 'days']
    };

    const activeModel = 'gemini-3.6-flash';
    logMessage(`Przetwarzanie przez model: ${activeModel}`);

    const model = genAI.getGenerativeModel({
      model: activeModel,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema
      }
    });

    const promptText = `Przeanalizuj treść i wyciągnij dane o wydarzeniu.
URL: ${url}
Tekst strony:
${extractedText.slice(0, 20000)}

ZASADY:
1. Rok: Podany w tekście lub załóż 2026.
2. Godziny UTC: Przelicz polski czas (czas letni: odejmij 2h; zimowy: odejmij 1h).
3. Opis (description): Wyciągnij kluczowe informacje i opis wydarzenia ze strony.
4. Zwróć JSON zgodny ze schematem.`;

    const result = await model.generateContent(promptText);
    const responseText = result.response.text();

    const parsedData = JSON.parse(responseText);
    parsedData.source_url = url;
    
    return res.json(parsedData);

  } catch (error) {
    logMessage('KRYTYCZNY BŁĄD SERWERA:', error);
    return res.status(500).json({ 
      error: 'Błąd przetwarzania wydarzenia', 
      details: error.message || 'Wystąpił błąd podczas analizy.'
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Urliqo działa na porcie ${PORT}`));
