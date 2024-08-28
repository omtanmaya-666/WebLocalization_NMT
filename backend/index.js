const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const { MongoClient } = require('mongodb');  // Import MongoDB client

const app = express();
const PORT = 5000;
const MONGODB_URI = 'mongodb://localhost:27017'; // Replace with your MongoDB connection string
const DATABASE_NAME = 'localizationDB';  // Your database name
const COLLECTION_NAME = 'translatedPages';  // Your collection name

let _language = 'en';

app.use(cors());
app.use(express.json());

// Function to connect to MongoDB
async function connectToMongoDB() {
  const client = new MongoClient(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  await client.connect();
  console.log('Connected to MongoDB');
  return client.db(DATABASE_NAME).collection(COLLECTION_NAME);
}

// Function to translate text using the NMT API
const translateText = async (texts, targetLanguage) => {
  const requestBody = {
    data: texts
  };

  try {
    const fetch = (await import('node-fetch')).default;

    // Log the text being sent to the NMT API
    console.log('Text being sent to NMT API:', requestBody.data);

    const response = await fetch('https://revapi.reverieinc.com', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'REV-API-KEY': '99425a49d90bbc4829af2934e823ce27b5b46a55',
        'REV-APP-ID': 'rev.interntesting',
        'src_lang': 'en',
        'tgt_lang': targetLanguage,
        'domain': '1',
        'REV-APPNAME': 'localization'
      },
      body: JSON.stringify(requestBody)
    });

    const data = await response.json();
    return data.responseList.map(item => item.outString);
  } catch (error) {
    console.error('Error translating text:', error);
    return texts; // Return original texts if translation fails
  }
};

const extractText_and_Translate = async (url, language, res) => {
  _language = language;

  if (!url || !language) {
    return res.status(400).json({ success: false, message: 'Invalid URL or language' });
  }

  try {
    const collection = await connectToMongoDB();

    // Check if the translated HTML for this URL is already in the database
    const existingEntry = await collection.findOne({ url: url, language: language });

    if (existingEntry) {
      console.log('URL found in database, returning cached translation.');
      return res.json({ success: true, content: existingEntry.translatedHTML });
    }

    // If not found in database, proceed with translation
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2' });

    // Extract text nodes from the webpage
    const { textNodesData, hrefLinks } = await page.evaluate((baseUrl) => {
      const textNodes = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);

      while (walker.nextNode()) {
        if (walker.currentNode.nodeValue.trim()) {
          textNodes.push(walker.currentNode.nodeValue.trim());
        }
      }

      const hrefLinks = [];
      const links = document.querySelectorAll('a[href]');
      links.forEach((link) => {
        const resolvedHref = new URL(link.getAttribute('href'), baseUrl).href;

        // Use regex to filter out unwanted links
        const unwantedLinkPattern = /(google\.[a-z.]+|facebook\.com|twitter\.com|linkedin\.com|instagram\.com|goo\.gl)/i;
        if (!unwantedLinkPattern.test(new URL(resolvedHref).hostname)) {
          link.href = resolvedHref; // Set the absolute URL to the link
          link.target = '_self';
          hrefLinks.push(resolvedHref);
        }
      });

      return {
        textNodesData: textNodes,
        hrefLinks: hrefLinks
      };
    }, url); // Pass the base URL to the evaluate function

    // Apply regex to remove unwanted patterns from the textNodesData
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const phoneRegex = /\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
    const ignoreRegexPatterns = [
        /<iframe[^>]*src="https:\/\/www\.googletagmanager\.com\/ns\.html\?id=GTM-NXK9CJ"[^>]*><\/iframe>/g,
        /→/g,
        /©/g,
    ];

    const filteredTextNodes = textNodesData.map(text => {
      // Remove emails and phone numbers
      let filteredText = text.replace(emailRegex, '').replace(phoneRegex, '');

      // Remove additional unwanted patterns
      ignoreRegexPatterns.forEach(pattern => {
        filteredText = filteredText.replace(pattern, '');
      });

      return filteredText.trim();  // Trim after filtering to remove any leftover spaces
    }).filter(text => text.length > 0); // Filter out empty strings

    // Translate the filtered text using the NMT API
    const translatedTexts = await translateText(filteredTextNodes, language);

    // Inject the translated text back into the page
    await page.evaluate((translatedTexts, serverPort, language) => {
      console.log(translateText)
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
      let index = 0;

      while (walker.nextNode()) {
        if (walker.currentNode.nodeValue.trim() && index < translatedTexts.length) {
          walker.currentNode.nodeValue = translatedTexts[index];
          index++;
        }
      }

      // Re-inject the script to handle link clicks and navigate using translated content
      const script = `
        document.addEventListener('click', function(event) {
          const link = event.target.closest('a');
          if (link) {
            event.preventDefault(); // Prevent default navigation
            const clickedLink = link.href;
            console.log('Last clicked link:', clickedLink);

            // Send the clicked link back to the server
            fetch('http://localhost:${serverPort}/api/localize', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ url: clickedLink, language: '${language}' }), // Send the language along with the clicked link
            }).then(response => response.json()).then(data => {
              const newDoc = document.open();
              newDoc.write(data.content);
              newDoc.close();
            });
          }
        });
      `;

      const scriptElement = document.createElement('script');
      scriptElement.textContent = script;
      document.body.appendChild(scriptElement);

    }, translatedTexts, PORT, language);

    // Get the translated HTML content
    const translatedHTML = await page.content();

    // Log the translated HTML to the console
    // console.log('Translated HTML:', translatedHTML);

    await browser.close();

    // Store the translated HTML in the MongoDB database
    await collection.insertOne({ url: url, language: language, translatedHTML: translatedHTML });
    console.log('Translated HTML stored in MongoDB');

    // Log all href links on the page
    console.log('All href links on the page:', hrefLinks);

    // Send the translated HTML back to the frontend
    res.json({ success: true, content: translatedHTML });
  } catch (error) {
    console.error('Error translating text:', error);
    res.status(500).json({ success: false, message: 'Failed to process the webpage' });
  }
};

// Route to handle URL localization and text translation
app.post('/api/localize', (req, res) => {
  const { url, language } = req.body;
  extractText_and_Translate(url, language, res);
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
