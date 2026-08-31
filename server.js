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

    // 1. CZYSZCZENIE URL (Szczególnie ważne dla FB i Tobilet)
    try {
      const parsedUrl = new URL(url);
      // Czyszczenie parametrów śledzących Facebooka i Google Analytics
      parsedUrl.search = ''; 
      url = parsedUrl.toString();
      logMessage(`Oczyszczony URL: ${url}`);
    } catch (e) {
      logMessage('Błąd parsowania URL, używam oryginalnego');
    }

    let extractedText = '';

    // 2. POBIERANIE TREŚCI STRONY
    // Najpierw próbujemy przez Jina Reader (najlepszy dla artykułów i FB)
    try {
      logMessage('Pobieranie przez Jina Reader...');
      const jinaRes = await axios.get(`https://r.jina.ai/${url}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'X-With-Generated-Alt': 'true'
        },
        timeout: 12000
      });

      if (jinaRes.data && typeof jinaRes.data === 'string' && jinaRes.data.length > 100) {
        extractedText = jinaRes.data;
        logMessage('Sukces: Pobrano przez Jina Reader.');
      }
    } catch (e) {
      logMessage('Jina Reader nie dał rady:', e.message);
    }

    // Fallback: Bezpośredni Axios
    if (!extractedText || extractedText.length < 100) {
      try {
        logMessage('Pobieranie bezpośrednie Axios...');
        const response = await axios.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8'
          },
          timeout: 10000
        });

        if (typeof response.data === 'string') {
          extractedText = response.data
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
            .replace(/<[^>]+>/g, '\n')
            .replace(/\n\s*\n/g, '\n');
        }
      } catch (axiosErr) {
        logMessage('Axios zgłosił błąd:', axiosErr.message);
      }
    }

    // Walidacja czy cokolwiek udało się pobrać
    if (!extractedText || extractedText.trim().length < 50) {
      logMessage('BŁĄD: Brak treści do analizy.');
      return res.status(422).json({ 
        error: 'Strona zablokowana lub brak treści',
        details: 'Portal blokuje automatyczny odczyt z serwerów zewnętrznych.'
      });
    }

    // 3. STRUKTURA SCHEMA DLA GEMINI
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
2. Godziny UTC: Przelicz polski czas (czas letni: odejmij 2h od podanej godziny; czas zimowy: odejmij 1h).
3. Zwróć JSON zgodny ze schematem.`;

    // 4. BEZPIECZNE WYWOŁANIE GEMINI (FALLBACK MODELI)
    // Zamiast jednej nazwy, próbujemy stabilnych identyfikatorów po kolei
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
        break; // Udało się, wychodzimy z pętli!
      } catch (err) {
        logMessage(`Błąd z modelem ${modelName}: ${err.message}`);
        lastError = err;
      }
    }

    if (!responseText) {
      throw lastError || new Error('Żaden model Gemini nie odpowiedział pomyślnie.');
    }

    const eventData = JSON.parse(responseText);
    res.json(eventData);

  } catch (error) {
    logMessage('KRYTYCZNY BŁĄD SERWERA:', error);
    res.status(500).json({ 
      error: 'Błąd przetwarzaania wydarzenia', 
      details: error.message 
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Urliqo działa na porcie ${PORT}`));
