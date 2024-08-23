const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

// Route to handle URL localization and text reversal
app.post('/api/localize', async (req, res) => {
  const { url, language } = req.body;

  if (!url || !language) {
    return res.status(400).json({ success: false, message: 'Invalid URL or language' });
  }

  try {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2' });

    // Pass the PORT to the page context as a parameter
    const result = await page.evaluate(async (url, serverPort) => {
      function reverseText(text) {
        const filteredText = text.replace(/[^a-zA-Z0-9\s]/g, ''); // Remove non-alphanumeric characters
        return filteredText.split('').reverse().join('');
      }

      const textNodes = [];
      const hrefLinks = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);

      while (walker.nextNode()) {
        textNodes.push(walker.currentNode);
      }

      const links = document.querySelectorAll('a[href]');
      links.forEach(link => {
        const resolvedHref = new URL(link.href, url).href;
        link.href = resolvedHref;
        link.target = '_self';
        hrefLinks.push(resolvedHref);
      });

      for (const node of textNodes) {
        node.nodeValue = reverseText(node.nodeValue);
      }

      // Inject a script to handle link clicks and store the clicked link
      const script = `
        document.addEventListener('click', function(event) {
          const link = event.target.closest('a');
          if (link) {
            event.preventDefault(); // Prevent default navigation
            const clickedLink = link.href;
            console.log('Last clicked link:', clickedLink);

            // Send the clicked link back to the server
            fetch('http://localhost:${serverPort}/api/log-clicked-link', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ clickedLink }),
            }).then(response => response.json()).then(data => {
              console.log('Clicked link logged on server:', data.clickedLink);

              window.location.href = clickedLink; // Navigate to the link
            });
          }
        });
      `;

      const scriptElement = document.createElement('script');
      scriptElement.textContent = script;
      document.body.appendChild(scriptElement);

      return {
        translatedHTML: document.documentElement.outerHTML,
        hrefLinks
      };
    }, url, PORT);  // Pass PORT as an argument to the page context

    await browser.close();

    // Log all href links on the page
    console.log('All href links on the page:', result.hrefLinks);

    // Send the modified HTML back to the frontend
    res.json({ success: true, content: result.translatedHTML });
  } catch (error) {
    console.error('Error reversing text:', error);
    res.status(500).json({ success: false, message: 'Failed to process the webpage' });
  }
});

// Endpoint to receive clicked link logs
app.post('/api/log-clicked-link', (req, res) => {
    
  const { clickedLink } = req.body;
 console.log('Received clicked link:', clickedLink);//Received clicked link: https://poetic.io/services
  res.status(200).json({ success: true, clickedLink });  // Return the clicked link
});


app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
