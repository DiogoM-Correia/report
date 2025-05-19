import Parser from 'rss-parser';

/**
 * Porto Tech News - Cloudflare Worker
 * 
 * This worker fetches news from various RSS feeds, filters for recent and unseen articles,
 * categorizes them, summarizes them, and sends a daily email report.
 */

// RSS feed parser
const parser = new Parser();

// Default RSS feeds if not configured
const DEFAULT_FEEDS = [
  'https://feed.infoq.com/articles',
  'https://news.ycombinator.com/rss',
  'https://thenewstack.io/feed',
  'https://www.techmeme.com/feed.xml',
  'https://www.techinporto.com/feed/',
  'https://www.portugaltechnews.com/feed/'
];

// Email provider configurations
const EMAIL_PROVIDERS = {
  sendgrid: {
    endpoint: 'https://api.sendgrid.com/v3/mail/send',
    headers: (apiKey) => ({
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }),
    formatPayload: (from, to, subject, content) => ({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from },
      subject,
      content: [
        { type: 'text/plain', value: content.text },
        { type: 'text/html', value: content.html }
      ]
    })
  },
  mailgun: {
    endpoint: 'https://api.mailgun.net/v3/YOUR_DOMAIN_NAME/messages',
    headers: (apiKey) => ({
      'Authorization': `Basic ${btoa(`api:${apiKey}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    }),
    formatPayload: (from, to, subject, content) => 
      new URLSearchParams({
        from,
        to,
        subject,
        text: content.text,
        html: content.html
      })
  }
};

// Email provider to use
const EMAIL_PROVIDER = 'sendgrid'; // or 'mailgun'

/**
 * Main handler for all HTTP requests
 */
export default {
  // Handle scheduled events (daily report)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(generateReport(env));
  },
  
  // Handle HTTP requests (manual triggering and testing)
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Health check endpoint
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(JSON.stringify({ 
        status: 'Porto Tech News service is running',
        timestamp: new Date().toISOString() 
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Manual report generation endpoint
    if (url.pathname === '/run-report' && request.method === 'POST') {
      // Run the report generation in the background
      ctx.waitUntil(generateReport(env));
      
      return new Response(JSON.stringify({ 
        status: 'Report generation started',
        timestamp: new Date().toISOString() 
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Not found for any other route
    return new Response('Not found', { status: 404 });
  }
};

/**
 * Main function to generate and send the report
 */
async function generateReport(env) {
  console.log('Starting report generation process...');
  
  try {
    // 1. Fetch news articles
    const articles = await fetchArticles(env);
    console.log(`Fetched ${articles.length} new articles`);
    
    if (articles.length === 0) {
      console.log('No new articles found');
      return;
    }
    
    // 2. Categorize articles
    const groupedArticles = groupArticlesByCategory(articles);
    
    // 3. Summarize articles
    const report = await generateSummary(groupedArticles, env);
    console.log('Report generated successfully');
    
    // 4. Save report to KV
    const reportDate = new Date().toISOString().split('T')[0];
    await saveReport(reportDate, report, env);
    console.log('Report saved to KV');
    
    // 5. Send email
    await sendReport(report, reportDate, env);
    console.log('Email sent successfully');
    
  } catch (error) {
    console.error('Error generating report:', error);
  }
}

/**
 * Get the list of RSS feeds from environment variables or use defaults
 */
function getFeedUrls(env) {
  if (env.FEED_LIST) {
    return env.FEED_LIST.split(',').map(url => url.trim());
  }
  return DEFAULT_FEEDS;
}

/**
 * Fetch articles from an RSS feed
 */
async function fetchFeed(feedUrl) {
  try {
    console.log(`Fetching feed: ${feedUrl}`);
    const feed = await parser.parseURL(feedUrl);
    
    console.log(`Found ${feed.items.length} articles in feed: ${feedUrl}`);
    return feed.items.map(item => ({
      ...item,
      source: feed.title || feedUrl,
      sourceUrl: feedUrl
    }));
  } catch (error) {
    console.error(`Error fetching feed ${feedUrl}:`, error);
    return [];
  }
}

/**
 * Check if an article was published within the last 24 hours
 */
function isRecent(pubDate) {
  if (!pubDate) return false;
  
  const articleDate = new Date(pubDate);
  const oneDayAgo = new Date();
  oneDayAgo.setHours(oneDayAgo.getHours() - 24);
  
  return articleDate > oneDayAgo;
}

/**
 * Extract a unique ID from an article
 */
function getArticleId(article) {
  return article.guid || article.link || article.id;
}

/**
 * Fetch articles from all RSS feeds and filter for unique, recent ones
 */
async function fetchArticles(env) {
  const feedUrls = getFeedUrls(env);
  
  // Fetch all feeds in parallel
  const feedPromises = feedUrls.map(url => fetchFeed(url));
  const feedResults = await Promise.all(feedPromises);
  
  // Flatten the array of feed items
  const allArticles = feedResults.flat();
  
  // Filter for recent articles
  const recentArticles = allArticles.filter(article => isRecent(article.pubDate || article.isoDate));
  console.log(`Found ${recentArticles.length} recent articles out of ${allArticles.length} total`);
  
  // Filter for unseen articles
  const unseenArticles = [];
  for (const article of recentArticles) {
    const articleId = getArticleId(article);
    
    if (!articleId) {
      console.warn('Article has no ID:', article.title);
      continue;
    }
    
    // Check if article has been seen before
    const hasBeenSeen = await env.SEEN_ARTICLES.get(articleId);
    
    if (!hasBeenSeen) {
      unseenArticles.push(article);
      // Mark the article as seen (with 30-day expiration)
      await env.SEEN_ARTICLES.put(articleId, JSON.stringify({
        title: article.title,
        source: article.source,
        pubDate: article.pubDate || article.isoDate
      }), {expirationTtl: 60 * 60 * 24 * 30}); // 30 days
    }
  }
  
  console.log(`Found ${unseenArticles.length} unseen articles out of ${recentArticles.length} recent`);
  
  // Sort by publication date (newest first)
  return unseenArticles.sort((a, b) => {
    const dateA = new Date(a.pubDate || a.isoDate);
    const dateB = new Date(b.pubDate || b.isoDate);
    return dateB - dateA;
  });
}

/**
 * Group articles by categories
 */
function groupArticlesByCategory(articles) {
  const categories = {
    vc_investments: [],
    market_moves_pt: [],
    market_moves_global: [],
    upcoming_events: []
  };
  
  // Categorization logic
  for (const article of articles) {
    const title = article.title.toLowerCase();
    const content = (article.content || article.contentSnippet || '').toLowerCase();
    
    // Check for VC investments
    if (
      title.includes('raise') || 
      title.includes('funding') || 
      title.includes('invest') || 
      title.includes('million') || 
      title.includes('venture') ||
      content.includes('series a') || 
      content.includes('series b') || 
      content.includes('raised') ||
      content.includes('investment round')
    ) {
      categories.vc_investments.push(article);
      continue;
    }
    
    // Check for Portuguese market news
    if (
      article.source.toLowerCase().includes('porto') ||
      article.source.toLowerCase().includes('portugal') ||
      title.includes('portugal') || 
      title.includes('porto') || 
      title.includes('lisbon') || 
      title.includes('lisboa') ||
      content.includes('portugal') || 
      content.includes('portuguese') ||
      content.includes('porto')
    ) {
      categories.market_moves_pt.push(article);
      continue;
    }
    
    // Check for events
    if (
      title.includes('event') || 
      title.includes('conference') || 
      title.includes('meetup') || 
      title.includes('webinar') ||
      content.includes('join us') || 
      content.includes('register now') ||
      content.includes('save the date')
    ) {
      categories.upcoming_events.push(article);
      continue;
    }
    
    // Default to global market news
    categories.market_moves_global.push(article);
  }
  
  return categories;
}

/**
 * Prepare a prompt for the language model
 */
function preparePrompt(groupedArticles) {
  let prompt = `You are the "Porto Tech News" agent, a specialized assistant that creates daily summaries of tech industry news focused on Portugal, particularly Porto's tech ecosystem.

Please analyze these articles and create a concise, insightful summary with the following sections:

1. VC investments and funding rounds
2. Market moves and news from the Portuguese tech scene
3. Global market moves and tech industry trends
4. Upcoming events (optional)

For each section, highlight key points using bullet points.

ARTICLES:
`;

  // Add articles by category
  for (const [category, articles] of Object.entries(groupedArticles)) {
    if (articles.length === 0) continue;
    
    prompt += `\n## ${category.toUpperCase()}:\n`;
    articles.forEach(article => {
      prompt += `- "${article.title}" (${article.source})\n`;
      if (article.contentSnippet) {
        prompt += `  ${article.contentSnippet.substring(0, 200)}...\n`;
      }
    });
  }
  
  prompt += `\nPlease respond with a JSON object structured as follows:
{
  "vc_investments": [
    {"headline": "Key point about investment 1", "details": "Brief details"},
    {"headline": "Key point about investment 2", "details": "Brief details"}
  ],
  "market_moves_pt": [
    {"headline": "Key point about Portugal tech scene 1", "details": "Brief details"},
    {"headline": "Key point about Portugal tech scene 2", "details": "Brief details"}
  ],
  "market_moves_global": [
    {"headline": "Key point about global tech 1", "details": "Brief details"},
    {"headline": "Key point about global tech 2", "details": "Brief details"}
  ],
  "upcoming_events": [
    {"name": "Event name 1", "date": "Event date", "location": "Event location"},
    {"name": "Event name 2", "date": "Event date", "location": "Event location"}
  ]
}`;
  
  return prompt;
}

/**
 * Call the GPT4All API to generate a report
 */
async function callGpt4All(prompt, env) {
  try {
    const endpoint = env.GPT4ALL_ENDPOINT || 'http://localhost:4891/v1/completions';
    console.log('Calling language model endpoint:', endpoint);
    
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': env.GPT4ALL_API_KEY ? `Bearer ${env.GPT4ALL_API_KEY}` : undefined
      },
      body: JSON.stringify({
        prompt,
        max_tokens: 2048,
        temperature: 0.7,
        top_p: 0.9,
        n: 1,
        echo: false
      })
    });
    
    if (!response.ok) {
      throw new Error(`API call failed with status ${response.status}`);
    }
    
    const data = await response.json();
    return JSON.parse(data.choices[0].text);
  } catch (error) {
    console.error('Error calling language model:', error);
    
    // Return a fallback response
    return {
      vc_investments: [],
      market_moves_pt: [],
      market_moves_global: [],
      upcoming_events: []
    };
  }
}

/**
 * Generate a summary report from grouped articles
 */
async function generateSummary(groupedArticles, env) {
  console.log('Grouped articles:', Object.keys(groupedArticles).map(key => `${key}: ${groupedArticles[key].length}`));
  
  // Prepare the prompt
  const prompt = preparePrompt(groupedArticles);
  
  // Call the language model
  const report = await callGpt4All(prompt, env);
  
  // Add metadata
  return {
    ...report,
    meta: {
      total_articles: Object.values(groupedArticles).flat().length,
      categories: Object.keys(groupedArticles).reduce((acc, key) => {
        acc[key] = groupedArticles[key].length;
        return acc;
      }, {}),
      generated_at: new Date().toISOString()
    }
  };
}

/**
 * Save a report to KV storage
 */
async function saveReport(date, report, env) {
  await env.REPORTS.put(date, JSON.stringify(report));
  return date;
}

/**
 * Format a date as a readable string
 */
function formatDate(dateStr) {
  const date = new Date(dateStr);
  const options = {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  };
  
  return date.toLocaleDateString('pt-PT', options);
}

/**
 * Render the report as HTML
 */
function renderHtmlEmail(report, date) {
  const formattedDate = formatDate(date);
  
  let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Porto Tech News - ${formattedDate}</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 800px;
      margin: 0 auto;
      padding: 20px;
    }
    h1 {
      color: #0066cc;
      border-bottom: 2px solid #0066cc;
      padding-bottom: 10px;
    }
    h2 {
      color: #0066cc;
      border-bottom: 1px solid #ddd;
      padding-bottom: 5px;
      margin-top: 30px;
    }
    .report-meta {
      color: #666;
      font-size: 0.9em;
      margin-bottom: 30px;
    }
    .news-item {
      margin-bottom: 20px;
    }
    .news-headline {
      font-weight: bold;
      font-size: 1.1em;
    }
    .news-details {
      margin-top: 5px;
      color: #444;
    }
    .footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #ddd;
      font-size: 0.9em;
      color: #666;
      text-align: center;
    }
  </style>
</head>
<body>
  <h1>Porto Tech News</h1>
  <div class="report-meta">
    <p>Report for ${formattedDate}</p>
    <p>Articles analyzed: ${report.meta?.total_articles || 'N/A'}</p>
  </div>`;
  
  // Add sections
  if (report.vc_investments && report.vc_investments.length > 0) {
    html += `
  <h2>💰 VC Investments & Funding</h2>`;
    
    report.vc_investments.forEach(item => {
      html += `
  <div class="news-item">
    <div class="news-headline">${item.headline}</div>
    <div class="news-details">${item.details}</div>
  </div>`;
    });
  }
  
  if (report.market_moves_pt && report.market_moves_pt.length > 0) {
    html += `
  <h2>🇵🇹 Portuguese Tech Scene</h2>`;
    
    report.market_moves_pt.forEach(item => {
      html += `
  <div class="news-item">
    <div class="news-headline">${item.headline}</div>
    <div class="news-details">${item.details}</div>
  </div>`;
    });
  }
  
  if (report.market_moves_global && report.market_moves_global.length > 0) {
    html += `
  <h2>🌐 Global Tech News</h2>`;
    
    report.market_moves_global.forEach(item => {
      html += `
  <div class="news-item">
    <div class="news-headline">${item.headline}</div>
    <div class="news-details">${item.details}</div>
  </div>`;
    });
  }
  
  if (report.upcoming_events && report.upcoming_events.length > 0) {
    html += `
  <h2>📅 Upcoming Events</h2>`;
    
    report.upcoming_events.forEach(item => {
      html += `
  <div class="news-item">
    <div class="news-headline">${item.name}</div>
    <div class="news-details">📆 ${item.date} | 📍 ${item.location}</div>
  </div>`;
    });
  }
  
  html += `
  <div class="footer">
    <p>Porto Tech News - Daily tech news digest</p>
    <p>Generated at ${new Date().toISOString()}</p>
  </div>
</body>
</html>`;
  
  return html;
}

/**
 * Render the report as plain text
 */
function renderTextEmail(report, date) {
  const formattedDate = formatDate(date);
  
  let text = `PORTO TECH NEWS - ${formattedDate}\n\n`;
  text += `Articles analyzed: ${report.meta?.total_articles || 'N/A'}\n\n`;
  
  // Add sections
  if (report.vc_investments && report.vc_investments.length > 0) {
    text += `💰 VC INVESTMENTS & FUNDING\n`;
    text += `---------------------------\n\n`;
    
    report.vc_investments.forEach(item => {
      text += `* ${item.headline}\n`;
      text += `  ${item.details}\n\n`;
    });
  }
  
  if (report.market_moves_pt && report.market_moves_pt.length > 0) {
    text += `🇵🇹 PORTUGUESE TECH SCENE\n`;
    text += `-------------------------\n\n`;
    
    report.market_moves_pt.forEach(item => {
      text += `* ${item.headline}\n`;
      text += `  ${item.details}\n\n`;
    });
  }
  
  if (report.market_moves_global && report.market_moves_global.length > 0) {
    text += `🌐 GLOBAL TECH NEWS\n`;
    text += `------------------\n\n`;
    
    report.market_moves_global.forEach(item => {
      text += `* ${item.headline}\n`;
      text += `  ${item.details}\n\n`;
    });
  }
  
  if (report.upcoming_events && report.upcoming_events.length > 0) {
    text += `📅 UPCOMING EVENTS\n`;
    text += `----------------\n\n`;
    
    report.upcoming_events.forEach(item => {
      text += `* ${item.name}\n`;
      text += `  📆 ${item.date} | 📍 ${item.location}\n\n`;
    });
  }
  
  text += `\n--\nPorto Tech News - Generated at ${new Date().toISOString()}\n`;
  
  return text;
}

/**
 * Send the report email via an email API
 */
async function sendReport(report, date, env) {
  const provider = EMAIL_PROVIDERS[EMAIL_PROVIDER];
  
  if (!provider || !env.EMAIL_API_KEY) {
    console.error('Email configuration is incomplete');
    return false;
  }
  
  try {
    const formattedDate = formatDate(date);
    
    // Email content
    const content = {
      html: renderHtmlEmail(report, date),
      text: renderTextEmail(report, date)
    };
    
    // Default email addresses
    const from = env.EMAIL_FROM || 'porto-tech-news@example.com';
    const to = env.EMAIL_TO || 'recipient@example.com';
    const subject = `Porto Tech News - ${formattedDate}`;
    
    // Format the request based on the provider
    const payload = provider.formatPayload(from, to, subject, content);
    
    // Send the email
    const response = await fetch(provider.endpoint, {
      method: 'POST',
      headers: provider.headers(env.EMAIL_API_KEY),
      body: typeof payload === 'string' ? payload : JSON.stringify(payload)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Email API error (${response.status}): ${errorText}`);
    }
    
    console.log('Email sent successfully');
    return true;
  } catch (error) {
    console.error('Error sending email:', error);
    return false;
  }
} 