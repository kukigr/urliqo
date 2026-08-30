import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Funkcja pomocnicza do zapisu logów do pliku
function logToFile(message, data = null) {
  const timestamp = new Date().toISOString();
  let logMessage = `[${timestamp}] ${message}\n`;
  if (data) {
    if (data instanceof Error) {
      logMessage += `Stack: ${data.stack}\nMessage: ${data.message}\n`;
    } else {
      logMessage += `Data: ${JSON.stringify(data, null, 2)}\n`;
    }
  }
  logMessage += '--------------------------------------------------\n';
  
  console.log(logMessage);
  fs.appendFileSync(path.join(process.cwd(), 'error.log'), logMessage, 'utf-8');
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.post('/api/parse-event', async (req, res) => {
  try {
    const { url } = req.body;
    logToFile(`Otrzymano żądanie przetworzenia URL: ${url}`);

    if (!url) {
      logToFile('Błąd: Brak adresu URL w żądaniu.');
      return res.status(400).json({ error: 'Brak adresu URL' });
    }

    let extractedText = '';
    try {
      logToFile('Pobieranie zawartości strony...');
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7'
        },
        timeout: 10000
      });

      // Oczyszczanie tekstu z tagów HTML
      extractedText = response.data
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .slice(0, 30000);

      logToFile(`Pobrano i oczyszczono tekst (długość: ${extractedText.length} znaków). Fragment:`, extractedText.slice(0, 300));
    } catch (fetchErr) {
      logToFile('Ostrzeżenie: Nie udało się pobrać treści strony przez axios. Powód:', fetchErr.message);
    }

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
              start_time_utc: { type: SchemaType.STRING, description: 'Data i godzina rozpoczęcia UTC w formacie ISO (np. 2026-09-25T08:00:00Z)' },
              end_time_utc: { type: SchemaType.STRING, description: 'Data i godzina zakończenia UTC w formacie ISO (np. 2026-09-25T16:00:00Z)' }
            },
            required: ['day_number', 'start_time_utc', 'end_time_utc']
          }
        }
      },
      required: ['title', 'location', 'source_url', 'days']
    };

    logToFile('Wysyłanie zapytania do modelu Gemini...');
	const model = genAI.getGenerativeModel({
      model: 'gemini-3.6-flash',
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

    logToFile('Otrzymana odpowiedź z Gemini:', responseText);

    const eventData = JSON.parse(responseText);
    res.json(eventData);

  } catch (error) {
    logToFile('KRYTYCZNY BŁĄD SERWERA:', error);
    res.status(500).json({ error: 'Nie udało się przetworzyć wydarzenia. Wyświetl plik error.log, aby poznać szczegóły.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Aplikacja działa na http://localhost:${PORT}`));