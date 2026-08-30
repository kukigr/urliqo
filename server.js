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

// Funkcja logująca bezpośrednio do konsoli Render.com
function logMessage(message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
  if (data) {
    if (data instanceof Error) {
      console.error(`STACK: ${data.stack}\nMESSAGE: ${data.message}`);
    } else {
      console.log(`DATA: ${JSON.stringify(data, null, 2)}`);
    }
  }
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.post('/api/parse-event', async (req, res) => {
  try {
    const { url } = req.body;
    logMessage(`Otrzymano żądanie dla URL: ${url}`);

    if (!url) {
      logMessage('Błąd: Brak adresu URL');
      return res.status(400).json({ error: 'Brak adresu URL' });
    }

    let extractedText = '';

    // PROBA 1: Pobieranie przez Axios
    try {
      logMessage('Pobieranie strony (Próba 1 - Axios)...');
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7'
        },
        timeout: 10000
      });

      extractedText = response.data
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .slice(0, 30000);

    } catch (fetchErr) {
      logMessage('Axios zablokowany lub błąd pobierania:', fetchErr.message);
    }

    // PROBA 2: Jina AI Reader (dla stron typu Resident Advisor / Cloudflare)
    if (!extractedText || extractedText.trim().length < 100) {
      try {
        logMessage('Próba 2: Używanie Jina AI Reader...');
        const jinaUrl = `https://r.jina.ai/${url}`;
        const jinaResponse = await axios.get(jinaUrl, { timeout: 15000 });
        extractedText = jinaResponse.data.slice(0, 30000);
        logMessage('Sukces Jina AI Reader!');
      } catch (jinaErr) {
        logMessage('Błąd Jina AI Reader:', jinaErr.message);
      }
    }

    logMessage(`Długość tekstu do analizy: ${extractedText.length} znaków.`);

    const schema = {
      type: SchemaType.OBJECT,
      properties: {
        title: { type: SchemaType.STRING, description: 'Nazwa wydarzenia' },
        location: { type: SchemaType.STRING, description: 'Pełny adres lub nazwa miejsca i miasto' },
        source_url: { type: SchemaType.STRING, description: 'Link źródłowy podany przez użytkownika' },
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

    logMessage('Wysyłanie zapytania do modelu Gemini...');
    
    // Zmiana na stabilny model gemini-1.5-flash
    const model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema
      }
    });

    const prompt = `Przeanalizuj poniższy adres URL oraz treść strony i wyciągnij szczegóły wydarzenia.
Strona URL: ${url}
Treść strony: ${extractedText}

Obecny rok to 2026. Przelicz godziny na strefę czasową UTC (Polska w okresie letnim to UTC+2, w zimowym UTC+1). Formatuj daty jako ISO.`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    logMessage('Odpowiedź z Gemini przetworzona pomyślnie.');

    const eventData = JSON.parse(responseText);
    res.json(eventData);

  } catch (error) {
    logMessage('KRYTYCZNY BŁĄD SERWERA:', error);
    res.status(500).json({ error: 'Nie udało się przetworzyć wydarzenia. Sprawdź zakłądkę Logs na Render.com.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Aplikacja Urliqo działa na porcie ${PORT}`));
