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

app.post('/api/parse-event', async (req, res) => {
  try {
    let { url } = req.body;
    logMessage(`Otrzymano żądanie dla URL: ${url}`);

    if (!url) {
      return res.status(400).json({ error: 'Nie podano adresu URL.' });
    }

    // 1. Oczyszczanie URL
    try {
      const parsedUrl = new URL(url);
      parsedUrl.search = ''; 
      url = parsedUrl.toString();
      logMessage(`Oczyszczony URL: ${url}`);
    } catch (e) {
      logMessage('Błąd parsowania URL, używam oryginalnego');
    }

    let extractedText = '';

    // 2. Pobieranie przez Jina Reader z obsługą autoryzacji oraz zapasowych nagłówków
    try {
      logMessage('Pobieranie przez Jina Reader...');
      
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'X-With-Generated-Alt': 'true',
        'X-No-Cache': 'true'
      };

      // Jeśli dodałeś JINA_API_KEY do zmiennych środowiskowych na Renderze
      if (process.env.JINA_API_KEY) {
        headers['Authorization'] = `Bearer ${process.env.JINA_API_KEY}`;
      }

      const jinaRes = await axios.get(`https://r.jina.ai/${url}`, {
        headers,
        timeout: 15000
      });

      if (jinaRes.data && typeof jinaRes.data === 'string' && jinaRes.data.length > 100) {
        extractedText = jinaRes.data;
        logMessage('Sukces: Pobrano przez Jina Reader.');
      }
    } catch (e) {
      logMessage('Jina Reader zgłosił błąd:', e.response ? `Status ${e.response.status}` : e.message);
    }

    // 3. Zapasowa próba przez alternatywne publiczne API proxy
    if (!extractedText || extractedText.length < 100) {
      try {
        logMessage('Pobieranie przez zapasowe proxy CORS...');
        const proxyRes = await axios.get(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`, {
          timeout: 10000
        });

        if (proxyRes.data && typeof proxyRes.data === 'string') {
          extractedText = proxyRes.data
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
            .replace(/<[^>]+>/g, '\n')
            .replace(/\n\s*\n/g, '\n');
        }
      } catch (proxyErr) {
        logMessage('Zapasowe proxy zgłosiło błąd:', proxyErr.message);
      }
    }

    // Jeśli strona całkowicie odrzuciła pobieranie
    if (!extractedText || extractedText.trim().length < 50) {
      logMessage('BŁĄD: Brak treści do analizy.');
      return res.status(422).json({ 
        error: 'Facebook zablokował dostęp do tego wydarzenia.',
        details: 'Dla wydarzeń z Facebooka wymagany jest bezpłatny klucz API Jina lub wklejenie linku z portalu biletowego.'
      });
    }

    // 4. Gemini Schema
    const schema = {
      type: SchemaType.OBJECT,
      properties: {
        title: { type: SchemaType.STRING, description: 'Nazwa wydarzenia' },
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
      required: ['title', 'location', 'source_url', 'days']
    };

    const promptText = `Przeanalizuj treść i wyciągnij dane o wydarzeniu.
URL: ${url}
Tekst strony:
${extractedText.slice(0, 30000)}

ZASADY:
1. Rok: Podany w tekście lub załóż 2026.
2. Godziny UTC: Przelicz polski czas (czas letni: odejmij 2h; zimowy: odejmij 1h).
3. Zwróć JSON zgodny ze schematem.`;

    // 5. Wywołanie Gemini z obsługą wielu modeli
    const candidateModels = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-pro'];
    let responseText = null;
    let lastError = null;

    for (const modelName of candidateModels) {
      try {
        logMessage(`Próba wywołania Gemini z modelem: ${modelName}...`);
        const model = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: schema
          }
        });

        const result = await model.generateContent(promptText);
        responseText = result.response.text();
        logMessage(`Sukces! Odpowiedział model: ${modelName}`);
        break;
      } catch (err) {
        logMessage(`Błąd z modelem ${modelName}: ${err.message}`);
        lastError = err;
      }
    }

    if (!responseText) {
      throw lastError || new Error('Żaden model Gemini nie odpowiedział pomyślnie.');
    }

    res.json(JSON.parse(responseText));

  } catch (error) {
    logMessage('KRYTYCZNY BŁĄD SERWERA:', error);
    res.status(500).json({ 
      error: 'Błąd przetwarzania wydarzenia', 
      details: error.message 
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Urliqo działa na porcie ${PORT}`));
