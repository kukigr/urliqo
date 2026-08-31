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
      logMessage('Błąd: Brak adresu URL');
      return res.status(400).json({ error: 'Nie podano adresu URL.' });
    }

    // Uczyszczenie URL z długich parametrów śledzących Analytics / Google Ads
    try {
      const cleanUrlObj = new URL(url);
      cleanUrlObj.searchParams.delete('_gl');
      cleanUrlObj.searchParams.delete('_gcl_au');
      cleanUrlObj.searchParams.delete('fbclid');
      url = cleanUrlObj.toString();
    } catch (e) {
      // Jeśli URL jest niestandardowy, zostawiamy oryginalny
    }

    let extractedText = '';

    // PROBA 1: Pobieranie przez Axios z pełnymi nagłówkami najnowszej przeglądarki
    try {
      logMessage('Pobieranie strony (Próba 1 - Axios)...');
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
          'Cache-Control': 'no-cache'
        },
        timeout: 8000
      });

      // Bezpieczniejsze usuwanie skryptów zachowujące znaki nowej linii
      extractedText = response.data
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
        .replace(/<[^>]+>/g, '\n')
        .replace(/\n\s*\n/g, '\n')
        .slice(0, 40000);

    } catch (fetchErr) {
      logMessage('Próba 1 (Axios) nie powiodła się:', fetchErr.message);
    }

    // PROBA 2: Czytnik Jina AI dla trudnych stron (ToBilet / Cloudflare / Single Page App)
    if (!extractedText || extractedText.trim().length < 150) {
      try {
        logMessage('Próba 2: Używanie Jina AI Reader dla stron dynamicznych...');
        const jinaUrl = `https://r.jina.ai/${url}`;
        const jinaResponse = await axios.get(jinaUrl, { 
          headers: {
            'X-With-Generated-Alt': 'true',
            'Accept': 'text/plain'
          },
          timeout: 15000 
        });

        extractedText = typeof jinaResponse.data === 'string' 
          ? jinaResponse.data.slice(0, 40000) 
          : JSON.stringify(jinaResponse.data).slice(0, 40000);

        logMessage('Sukces Jina AI Reader!');
      } catch (jinaErr) {
        logMessage('Błąd Jina AI Reader:', jinaErr.message);
      }
    }

    // Jeśli strona całkowicie zablokowała dostęp bota
    if (!extractedText || extractedText.trim().length < 50) {
      logMessage('BŁĄD: Strona jest zablokowana przez zabezpieczenia antybotowe.');
      return res.status(422).json({ 
        error: 'Strona zablokowana lub nieobsługiwana',
        details: 'Ten portal stosuje zabezpieczenia antybotowe i blokuje automatyczne pobieranie wydarzeń.'
      });
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
              start_time_utc: { type: SchemaType.STRING, description: 'Data i godzina rozpoczęcia UTC w formacie ISO' },
              end_time_utc: { type: SchemaType.STRING, description: 'Data i godzina zakończenia UTC w formacie ISO' }
            },
            required: ['day_number', 'start_time_utc', 'end_time_utc']
          }
        }
      },
      required: ['title', 'location', 'source_url', 'days']
    };

    logMessage('Wysyłanie zapytania do Gemini...');
    const model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema
      }
    });

    const prompt = `Przeanalizuj poniższy adres URL oraz treść strony i wyciągnij szczegóły wydarzenia.

Strona URL: ${url}
Treść strony:
${extractedText}

ZASADY:
1. Rok wydarzenia: Podany w treści lub zakładasz 2026.
2. Przelicz godziny na strefę czasową UTC (Polska w okresie letnim, czyli od końca marca do końca października, używa UTC+2, zatem odejmij 2 godziny od podanych godzin lokalnych).
3. Podziel wydarzenie na osobne dni, jeśli w tekście są podane osobne godziny dla każdego dnia (np. Piątek 11:00-20:00, Sobota 9:00-20:00, Niedziela 9:00-18:00).
4. Formatuj daty jako ISO z oznaczeniem UTC (np. 2026-10-23T09:00:00.000Z).`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    logMessage('Odpowiedź z Gemini przetworzona pomyślnie.');
    const eventData = JSON.parse(responseText);
    res.json(eventData);

  } catch (error) {
    logMessage('KRYTYCZNY BŁĄD SERWERA:', error);
    res.status(500).json({ 
      error: 'Błąd przetwarzania wydarzenia', 
      details: 'Wystąpił nieoczekiwany problem podczas analizy strony przez AI.' 
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Aplikacja Urliqo działa na porcie ${PORT}`));
