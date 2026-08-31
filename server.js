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

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7'
};

app.post('/api/parse-event', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'Nie podano adresu URL.' });
    }

    console.log(`[LOG] Przetwarzanie URL: ${url}`);

    let targetUrl = url;
    // Zamiana wersji www na mobilną mbasic bez usuwania parametrów query
    if (url.includes('facebook.com') && !url.includes('mbasic.facebook.com')) {
      targetUrl = url.replace('www.facebook.com', 'mbasic.facebook.com')
                     .replace('web.facebook.com', 'mbasic.facebook.com');
    }

    let rawHtml = '';

    // Krok 1: Direct fetch z mbasic
    try {
      const response = await axios.get(targetUrl, {
        headers: BROWSER_HEADERS,
        timeout: 8000
      });
      rawHtml = response.data;
    } catch (e) {
      console.log(`[LOG] Direct fetch nie powiódł się: ${e.message}`);
    }

    // Krok 2: Jina Fallback tylko gdy direct fetch zwrócił mniej niż 500 znaków
    if (!rawHtml || rawHtml.length < 500) {
      try {
        console.log('[LOG] Próba pobrania przez Jina Reader...');
        const jinaHeaders = { ...BROWSER_HEADERS };
        if (process.env.JINA_API_KEY) {
          jinaHeaders['Authorization'] = `Bearer ${process.env.JINA_API_KEY}`;
        }
        const jinaRes = await axios.get(`https://r.jina.ai/${url}`, {
          headers: jinaHeaders,
          timeout: 10000
        });
        if (jinaRes.data && jinaRes.data.length > 300) {
          rawHtml = jinaRes.data;
        }
      } catch (e) {
        console.log(`[LOG] Jina Reader fallback nie powiódł się: ${e.message}`);
      }
    }

    // Sanity check pobranej treści
    if (!rawHtml || rawHtml.length < 200) {
      return res.status(422).json({
        error: 'Nie udało się pobrać treści strony',
        details: 'Facebook zablokował dostęp do wydarzenia lub link jest nieprawidłowy.'
      });
    }

    // Oczyszczanie ze zbędnego kodu
    const cleanText = rawHtml
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Schemat Gemini
    const schema = {
      type: SchemaType.OBJECT,
      properties: {
        title: { type: SchemaType.STRING, description: 'Tytuł wydarzenia' },
        description: { type: SchemaType.STRING, description: 'Szczegółowy opis wydarzenia, agendę oraz istotne informacje organizacyjne' },
        location: { type: SchemaType.STRING, description: 'Miejsce wydarzenia (nazwa obiektu, adres, miasto)' },
        days: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              day_number: { type: SchemaType.INTEGER },
              start_time_utc: { type: SchemaType.STRING, description: 'Data i godzina rozpoczęcia w ISO 8601 UTC' },
              end_time_utc: { type: SchemaType.STRING, description: 'Data i godzina zakończenia w ISO 8601 UTC' }
            },
            required: ['day_number', 'start_time_utc', 'end_time_utc']
          }
        }
      },
      required: ['title', 'description', 'location', 'days']
    };

    const model = genAI.getGenerativeModel({
      model: 'gemini-3.6-flash',
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema
      }
    });

    const prompt = `Wyciągnij dane o wydarzeniu z poniższego surowego tekstu strony:
URL źródłowy: ${url}

TEKST STRONY:
${cleanText.slice(0, 15000)}

ZASADY ANALIZY:
1. Jeżeli rok nie jest wprost podany, przyjmij rok 2026.
2. Przelicz podane godziny na strefę UTC (Polska: Zima = UTC+1, Lato = UTC+2).
3. Pole 'description' MUSI zawierać podsumowanie opisu wydarzenia. Wyciągnij kluczowe informacje z tekstu.
4. Jeżeli w tekście brakuje tytułu lub dat, oznacza to że strona została zablokowana przez login-wall.`;

    const result = await model.generateContent(prompt);
    const parsedData = JSON.parse(result.response.text());
    parsedData.source_url = url;

    return res.json(parsedData);

  } catch (error) {
    console.error('[KRYTYCZNY BŁĄD SERWERA]:', error);
    return res.status(500).json({
      error: 'Błąd przetwarzenia wydarzenia przez AI',
      details: error.message
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Urliqo uruchomione na porcie ${PORT}`));
