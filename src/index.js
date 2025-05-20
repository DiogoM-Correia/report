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
const DEFAULT_FEEDS = {
  pt_tech: [
    'https://eco.sapo.pt/topico/empreendedorismo/feed/',
  ],
  global_tech: [
    'https://techcrunch.com/category/venture/feed',
    'https://techcrunch.com/category/startups/feed',
    'https://sifted.eu/feed'
  ]
};

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

// AI model configuration
const AI_CONFIG = {
  endpoint: 'https://api-inference.huggingface.co/models/facebook/bart-large-cnn',
  backupEndpoint: 'https://api-inference.huggingface.co/models/HuggingFaceH4/zephyr-7b-beta',
  inputFormat: (prompt) => ({ inputs: prompt }),
  responseHandler: (data) => {
    if (Array.isArray(data) && data[0] && data[0].generated_text) {
      return data[0].generated_text;
    } else if (typeof data === 'object' && data.generated_text) {
      return data.generated_text;
    } else if (Array.isArray(data) && data[0] && data[0].summary_text) {
      return data[0].summary_text;
    } else {
      return JSON.stringify(data);
    }
  }
};

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
    
    // Get the latest report endpoint
    if (url.pathname === '/latest-report') {
      // Check if we have a report stored
      if (!globalThis.lastReport) {
        return new Response(JSON.stringify({
          error: 'No report available. Run /run-report endpoint first.'
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Get the requested format from query parameter
      const format = url.searchParams.get('format') || 'json';
      
      if (format === 'json') {
        return new Response(JSON.stringify(globalThis.lastReport), {
          headers: { 'Content-Type': 'application/json' }
        });
      } else if (format === 'html') {
        return new Response(globalThis.lastReport.content.html, {
          headers: { 'Content-Type': 'text/html' }
        });
      } else if (format === 'text') {
        return new Response(globalThis.lastReport.content.text, {
          headers: { 'Content-Type': 'text/plain' }
        });
      } else {
        return new Response(JSON.stringify({
          error: 'Invalid format. Use json, html, or text.'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
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
  
  // Temporary testing flag - set to false to skip sending emails
  const shouldSendEmail = false;
  
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
    
    // 5. Save report locally for faster iterations
    await saveReportLocally(report, reportDate);
    console.log('Report saved locally');
    
    // 6. Send email (if enabled)
    if (shouldSendEmail) {
      await sendReport(report, reportDate, env);
      console.log('Email sent successfully');
    } else {
      console.log('Email sending skipped for testing');
    }
    
  } catch (error) {
    console.error('Error generating report:', error);
  }
}

/**
 * Save the report to a local file for easier testing
 */
async function saveReportLocally(report, date) {
  try {
    // Generate the file content
    const content = {
      html: renderHtmlEmail(report, date),
      json: JSON.stringify(report, null, 2),
      text: renderTextEmail(report, date)
    };
    
    // In Cloudflare Workers environment, we can't use fs
    // Instead, return the content as an HTTP response
    const responseData = {
      date,
      content,
      message: 'Report generated successfully. Copy this data for local testing.'
    };
    
    // Create a global variable to store the last report
    // eslint-disable-next-line no-undef
    globalThis.lastReport = responseData;
    
    console.log('Report saved to globalThis.lastReport - access it from the fetch handler');
    
    return true;
  } catch (error) {
    console.error('Error saving report content:', error);
    return false;
  }
}

/**
 * Get the list of RSS feeds for all categories from environment variables or use defaults
 */
function getFeedUrls(env) {
  const feedConfig = {};
  
  // Check for category-specific feed configurations in environment
  for (const category of Object.keys(DEFAULT_FEEDS)) {
    const envKey = `FEED_LIST_${category.toUpperCase()}`;
    if (env[envKey]) {
      feedConfig[category] = env[envKey].split(',').map(url => url.trim());
    } else {
      feedConfig[category] = DEFAULT_FEEDS[category];
    }
  }
  
  return feedConfig;
}

/**
 * Fetch articles from all RSS feeds and filter for unique, recent ones
 */
async function fetchArticles(env) {
  const feedConfig = getFeedUrls(env);
  let allArticles = [];
  let fetchedUrls = new Set(); // To track already fetched feed URLs
  
  // For each category, fetch its specific feeds
  for (const category in feedConfig) {
    console.log(`Fetching feeds for category: ${category}`);
    
    const feedUrls = feedConfig[category];
    // Handle empty feed lists
    if (!feedUrls || feedUrls.length === 0) continue;
    
    // Fetch all feeds for this category in parallel
    const feedPromises = [];
    
    for (const url of feedUrls) {
      // Skip if already fetched (avoid duplicate work)
      if (fetchedUrls.has(url)) {
        console.log(`Skipping already fetched feed: ${url}`);
        continue;
      }
      
      fetchedUrls.add(url);
      feedPromises.push(fetchFeed(url, category));
    }
    
    const feedResults = await Promise.all(feedPromises);
    
    // Flatten the array of feed items
    const categoryArticles = feedResults.flat();
    allArticles = allArticles.concat(categoryArticles);
  }
  
  // Filter for recent articles
  const recentArticles = allArticles.filter(article => isRecent(article.pubDate || article.isoDate));
  console.log(`Found ${recentArticles.length} recent articles out of ${allArticles.length} total`);
  
  // TEMPORARY FOR TESTING: Skip the seen/unseen check and use all recent articles
  const useSeenCheck = false; // Change to true in production
  
  if (!useSeenCheck) {
    console.log('TESTING MODE: Using all recent articles regardless of seen status');
    return recentArticles.sort((a, b) => {
      const dateA = new Date(a.pubDate || a.isoDate);
      const dateB = new Date(b.pubDate || b.isoDate);
      return dateB - dateA;
    });
  }
  
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
 * Fetch articles from an RSS feed
 */
async function fetchFeed(feedUrl, sourceCategory) {
  try {
    console.log(`Fetching feed: ${feedUrl} for ${sourceCategory}`);
    
    // Create a date object for 24 hours ago
    const oneDayAgo = new Date();
    oneDayAgo.setHours(oneDayAgo.getHours() - 24);
    
    // Prepare headers to optimize fetching
    const headers = {
      'Accept': 'application/rss+xml, application/xml, text/xml, application/atom+xml',
      'If-Modified-Since': oneDayAgo.toUTCString() // Only get content modified in last 24 hours
    };
    
    // Handle pagination or count parameters for feeds that support them
    let optimizedUrl = feedUrl;
    
    // Add date parameters for feeds that support them
    if (feedUrl.includes('techcrunch.com')) {
      // TechCrunch allows limiting by date
      const dateStr = oneDayAgo.toISOString().split('T')[0]; // YYYY-MM-DD
      if (!feedUrl.includes('after=')) {
        optimizedUrl += feedUrl.includes('?') ? `&after=${dateStr}` : `?after=${dateStr}`;
      }
    }
    
    // Removed article count limit as per user request
    
    // Use fetch API with optimized parameters
    const response = await fetch(optimizedUrl, { headers });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const xml = await response.text();
    const feed = await parser.parseString(xml);
    
    // Even with optimized fetching, still filter by date locally as a safety measure
    const recentItems = feed.items.filter(item => isRecent(item.pubDate || item.isoDate));
    
    console.log(`Found ${feed.items.length} articles in feed, ${recentItems.length} from last 24h: ${feedUrl}`);
    
    return recentItems.map(item => ({
      ...item,
      source: feed.title || feedUrl,
      sourceUrl: feedUrl,
      sourceCategory: sourceCategory // Track which category feed this came from
    }));
  } catch (error) {
    console.error(`Error fetching feed ${feedUrl}:`, error);
    return [];
  }
}

/**
 * Check if an article was published within the last 24 hours - strict enforcement
 */
function isRecent(pubDate) {
  if (!pubDate) return false;
  
  const articleDate = new Date(pubDate);
  const oneDayAgo = new Date();
  oneDayAgo.setHours(oneDayAgo.getHours() - 24);
  
  // Strict 24-hour limit
  return articleDate >= oneDayAgo;
}

/**
 * Extract a unique ID from an article
 */
function getArticleId(article) {
  return article.guid || article.link || article.id;
}

/**
 * Group articles by categories with smarter categorization
 */
function groupArticlesByCategory(articles) {
  const categories = {
    pt_tech: [],
    global_tech: []
  };
  
  // First pass: Create a map of article URLs to prevent duplicates
  const articleMap = {};
  
  // Categorization logic - allow articles to be initially added to multiple categories
  for (const article of articles) {
    // Extract article properties
    const title = article.title.toLowerCase();
    const content = (article.contentSnippet || article.content || '').toLowerCase();
    const link = article.link || '';
    const sourceCategory = article.sourceCategory;
    
    // Skip if no link available
    if (!link) continue;
    
    // Create a unique ID for this article (URL-based)
    const articleId = getArticleId(article);
    
    // Initialize this article in our tracking map if not present
    if (!articleMap[articleId]) {
      articleMap[articleId] = {
        article: article,
        categories: new Set(),
        scores: {}
      };
    }
    
    // Determine which categories this article belongs to
    
    // First consider the source category as a hint (but not a guarantee)
    if (sourceCategory && sourceCategory !== 'general') {
      articleMap[articleId].categories.add(sourceCategory);
    }
    
    // Then apply categorization rules
    
    // Check for Portuguese tech news
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
      articleMap[articleId].categories.add('pt_tech');
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
      articleMap[articleId].categories.add('events');
    }
    
    // Default to global tech news if no other category was assigned
    if (articleMap[articleId].categories.size === 0) {
      articleMap[articleId].categories.add('global_tech');
    }
  }
  
  // Calculate relevance scores for each article in each of its potential categories
  for (const articleId in articleMap) {
    const entry = articleMap[articleId];
    const article = entry.article;
    
    // Score the article for each category it belongs to
    for (const category of entry.categories) {
      const score = calculateRelevanceScore(article, category);
      entry.scores[category] = score;
    }
  }
  
  // Determine the final category for each article (highest score wins)
  for (const articleId in articleMap) {
    const entry = articleMap[articleId];
    let bestCategory = null;
    let highestScore = -1;
    
    for (const category of entry.categories) {
      const score = entry.scores[category];
      if (score > highestScore) {
        highestScore = score;
        bestCategory = category;
      }
    }
    
    // Add the article to its best category
    if (bestCategory && categories[bestCategory]) {
      // Create a copy of the article with the finalized category and score
      const categorizedArticle = {
        ...entry.article,
        originalLink: entry.article.link,
        relevanceScore: highestScore,
        finalCategory: bestCategory
      };
      
      categories[bestCategory].push(categorizedArticle);
    }
  }
  
  // Log the distribution
  for (const category in categories) {
    console.log(`Category ${category} has ${categories[category].length} articles`);
  }
  
  return categories;
}

/**
 * Prepare a prompt for the language model
 */
function preparePrompt(groupedArticles, env) {
  // Create a prompt for Hugging Face models
  let prompt = `You are the "Porto Tech News" agent. Create a summary of tech news focused on Portugal.

Generate a structured JSON response with these categories:
- pt_tech: Portuguese tech scene updates
- global_tech: Global tech trends

Here are the articles by category:\n`;
  
  // Add articles by category
  for (const [category, articles] of Object.entries(groupedArticles)) {
    if (articles.length === 0) continue;
    
    let categoryName = "";
    switch(category) {
      case "pt_tech": categoryName = "Portuguese Tech"; break;
      case "global_tech": categoryName = "Global Tech"; break;
      default: categoryName = category;
    }
    
    prompt += `\n${categoryName}:\n`;
    
    // Limit to 3 articles per category to keep the prompt manageable
    const limitedArticles = articles.slice(0, 3);
    limitedArticles.forEach((article, index) => {
      prompt += `- "${article.title}" (${article.source}) - Link: ${article.originalLink || article.link}\n`;
      if (article.contentSnippet) {
        prompt += `  ${article.contentSnippet.substring(0, 100)}...\n`;
      }
    });
  }
  
  // Add expected JSON format with a clear, direct instruction
  prompt += `
Return ONLY a JSON object with this exact structure (do not include any other text):

{
  "pt_tech": [
    {"headline": "Portuguese tech news", "details": "Details about Portuguese tech", "link": "Original article URL"}
  ],
  "global_tech": [
    {"headline": "Global tech news", "details": "Details about global tech", "link": "Original article URL"}
  ]
}`;
  
  console.log('Created Hugging Face prompt, length:', prompt.length);
  return prompt;
}

/**
 * Generate a summary report from grouped articles
 */
async function generateSummary(groupedArticles, env) {
  console.log('Grouped articles:', Object.keys(groupedArticles).map(key => `${key}: ${groupedArticles[key].length}`));
  
  try {
    // Prepare the prompt
    const prompt = preparePrompt(groupedArticles, env);
    console.log('Prompt prepared, length:', prompt.length);
    
    // Log a sample of the prompt
    if (prompt.length > 500) {
      console.log('Prompt sample:', prompt.substring(0, 250) + '...' + prompt.substring(prompt.length - 250));
    } else {
      console.log('Full prompt:', prompt);
    }
    
    // Call the language model
    const report = await callHuggingFace(prompt, env, groupedArticles);
    
    // Add metadata
    return {
      ...report,
      meta: {
        total_articles: Object.values(groupedArticles).flat().length,
        categories: Object.keys(groupedArticles).reduce((acc, key) => {
          acc[key] = groupedArticles[key].length;
          return acc;
        }, {}),
        generated_at: new Date().toISOString(),
        ai_used: true
      }
    };
  } catch (error) {
    console.error('Error generating AI summary:', error.message);
    
    // Create a fallback report using actual articles
    const fallbackReport = generateFallbackReport(groupedArticles, env);
    
    return {
      ...fallbackReport,
      meta: {
        total_articles: Object.values(groupedArticles).flat().length,
        error: error.message,
        generated_at: new Date().toISOString(),
        ai_used: false
      }
    };
  }
}

/**
 * Call the Hugging Face Inference API
 */
async function callHuggingFace(prompt, env, groupedArticles) {
  try {
    // Use the text-generation endpoint which should be available
    const endpoint = env.HUGGINGFACE_ENDPOINT || AI_CONFIG.endpoint;
    console.log('Calling Hugging Face endpoint:', endpoint);
    
    // Use the API key from env vars
    const apiKey = env.HUGGINGFACE_API_KEY;
    if (!apiKey) {
      throw new Error('No Hugging Face API key provided');
    } else {
      console.log('Using provided Hugging Face API key');
    }
    
    // Log the request details
    console.log(`Preparing request to Hugging Face (prompt length: ${prompt.length} chars)`);
    
    // Make the API request
    const startTime = Date.now();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        inputs: prompt,
        parameters: {
          max_new_tokens: 1024,
          temperature: 0.7
        }
      })
    });
    const endTime = Date.now();
    console.log(`Hugging Face API responded in ${endTime - startTime}ms with status ${response.status}`);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Hugging Face API error response:', errorText);
      
      // If the primary endpoint fails, try the backup if it's different
      if (endpoint !== AI_CONFIG.backupEndpoint && AI_CONFIG.backupEndpoint) {
        console.log('Trying backup endpoint:', AI_CONFIG.backupEndpoint);
        
        const backupResponse = await fetch(AI_CONFIG.backupEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            inputs: prompt,
            parameters: {
              max_new_tokens: 1024,
              temperature: 0.7
            }
          })
        });
        
        if (!backupResponse.ok) {
          // If backup also fails, use the fallback generator
          console.log('Backup endpoint also failed. Using fallback report generator.');
          return generateFallbackReport(groupedArticles, env);
        }
        
        const backupData = await backupResponse.json();
        console.log('Received data from backup endpoint');
        return processModelResponse(backupData, groupedArticles, env);
      }
      
      throw new Error(`API call failed with status ${response.status}: ${errorText}`);
    }
    
    // Handle the response
    const data = await response.json();
    console.log('Received data from Hugging Face:', typeof data, Array.isArray(data) ? `(array of ${data.length})` : '');
    
    // Process the response - no need to check for errors since our processModelResponse handles
    // non-JSON responses appropriately now
    const report = processModelResponse(data, groupedArticles, env);
    return report;
  } catch (error) {
    console.error('Error calling Hugging Face:', error);
    console.log('Using fallback report generator due to API error');
    return generateFallbackReport(groupedArticles, env);
  }
}

/**
 * Process the response from the model and extract usable data
 */
function processModelResponse(data, groupedArticles, env) {
  // First try to use the responseHandler from AI_CONFIG
  let resultText = '';
  
  // Log the structure of the response to understand it better
  if (Array.isArray(data)) {
    console.log('Response is an array with first item:', JSON.stringify(data[0]).substring(0, 200) + '...');
    if (data[0] && data[0].generated_text) {
      resultText = data[0].generated_text;
      console.log('Found generated_text in array item');
    } else if (data[0] && data[0].summary_text) {
      resultText = data[0].summary_text;
      console.log('Found summary_text in array item');
    }
  } else if (typeof data === 'object') {
    console.log('Response is an object with keys:', Object.keys(data));
    if (data.generated_text) {
      resultText = data.generated_text;
      console.log('Found generated_text directly in object');
    } else if (data.summary_text) {
      resultText = data.summary_text;
      console.log('Found summary_text directly in object');
    }
  }
  
  if (!resultText) {
    resultText = JSON.stringify(data);
    console.log('Could not extract generated_text, using full response');
  }
  
  console.log('Result text length:', resultText.length);
  if (resultText.length > 200) {
    console.log('Result text sample:', resultText.substring(0, 100) + '...' + resultText.substring(resultText.length - 100));
  } else {
    console.log('Full result text:', resultText);
  }
  
  // First try to parse as JSON
  try {
    // Look for JSON in the response text (model might include explanations before/after)
    console.log('Trying to extract JSON from response');
    const jsonMatch = resultText.match(/\{[\s\S]*?\}(?=\n|$)/);
    if (jsonMatch) {
      console.log('Found JSON-like content in response');
      const jsonString = jsonMatch[0];
      
      try {
        const parsedJson = JSON.parse(jsonString);
        console.log('Successfully parsed JSON');
        return parsedJson;
      } catch (innerError) {
        console.log('Error parsing extracted JSON - using summarization approach');
        // Don't immediately fall back - try other parsing approaches
      }
    } else {
      console.log('No JSON-like content found in response - using summarization approach');
      
      // Special handling for BART and other summarization models
      console.log('Attempting to extract information from summarization response');
      
      // For BART model, the summary_text often contains a condensed version of the categories
      if (resultText.toLowerCase().includes('tech news') || 
          resultText.toLowerCase().includes('pt_tech') || 
          resultText.toLowerCase().includes('global_tech') ||
          resultText.toLowerCase().includes('portuguese tech')) {
        
        console.log('Found tech news categories in summary text, using as topics');
        
        // Extract category information from the text if possible
        // This is just for logging - we'll still use the actual articles
        const categoryMap = {
          'pt_tech': ['portugal', 'portuguese', 'porto', 'lisbon'],
          'global_tech': ['global', 'tech trends', 'technology'],
        };
        
        // Log what we're doing
        console.log('Parsing summary text into topics and using actual articles for content');
        
        // Use the grouped articles to create a report with the actual article content
        return createReportFromTopArticles(groupedArticles, resultText, env);
      }
    }
  } catch (jsonError) {
    console.log('Failed to extract or parse JSON from API response - using summarization approach');
  }
  
  // If we get here, fall back to using the article data directly
  console.log('Using fallback report generator with actual articles');
  return generateFallbackReport(groupedArticles, env);
}

/**
 * Calculate a relevance score for each article
 * Higher score = more relevant
 */
function calculateRelevanceScore(article, category) {
  let score = 0;
  const title = (article.title || '').toLowerCase();
  const content = (article.contentSnippet || article.content || '').toLowerCase();
  const pubDate = article.pubDate || article.isoDate;
  
  // Base score components
  const MAX_TITLE_MATCH_SCORE = 40;  // Max points for title keyword match
  const MAX_CONTENT_MATCH_SCORE = 30; // Max points for content keyword match
  const MAX_SOURCE_SCORE = 15;   // Reduced from 20 to balance better with content value
  const MAX_LENGTH_SCORE = 10;   // Max points for content length
  const MAX_CONTENT_VALUE_SCORE = 25; // New: Points for valuable content (funding details, etc)
  
  // 1. Keyword matching based on category (max 40 + 30 = 70 points)
  const categoryKeywords = {
    pt_tech: ['portugal', 'portuguese', 'porto', 'lisbon', 'lisboa', 'braga', 'aveiro', 'coimbra', 'tech', 'technology', 'empresa', 'startup'],
    global_tech: ['tech', 'technology', 'ai', 'artificial intelligence', 'machine learning', 'cloud', 'product', 'launch', 'software', 'digital']
  };
  
  const keywords = categoryKeywords[category] || [];
  
  // Score for keywords in title (more important)
  let titleMatchScore = 0;
  for (const keyword of keywords) {
    if (title.includes(keyword)) {
      // Add points based on how early the keyword appears in the title
      const position = title.indexOf(keyword);
      const positionFactor = 1 - (position / title.length);
      titleMatchScore += 4 + (8 * positionFactor); // 4-12 points per keyword based on position
    }
  }
  // Cap title match score
  score += Math.min(titleMatchScore, MAX_TITLE_MATCH_SCORE);
  
  // Score for keywords in content
  let contentMatchScore = 0;
  for (const keyword of keywords) {
    // Count occurrences of keyword in content
    const matches = content.split(keyword).length - 1;
    if (matches > 0) {
      // Add points based on frequency, with diminishing returns
      contentMatchScore += Math.min(8, 2 + Math.log(matches) * 3);
    }
  }
  // Cap content match score
  score += Math.min(contentMatchScore, MAX_CONTENT_MATCH_SCORE);
  
  // 2. Source quality score (max 15 points - reduced to balance with content value)
  // Prioritize certain high-quality sources
  const sourceName = (article.source || '').toLowerCase();
  const highQualitySources = {
    'techinporto': 15,
    'portugaltechnews': 15,
    'eco.sapo': 15,
    'dinheirovivo': 15,
    'techcrunch': 12, // Reduced from 17 since some content can be promotional
    'wired': 14,
    'the new stack': 13,
    'hacker news': 14,
    'infoq': 13,
    'techmeme': 12
  };
  
  for (const [source, points] of Object.entries(highQualitySources)) {
    if (sourceName.includes(source)) {
      score += points;
      break; // Only count the highest matching source
    }
  }
  
  // 3. Content length/detail score (max 10 points)
  // Longer content often has more detail
  if (content) {
    const contentLength = content.length;
    // Log scale to avoid oversized articles dominating
    const lengthScore = Math.min(MAX_LENGTH_SCORE, Math.log(Math.max(100, contentLength)) * 1.5);
    score += lengthScore;
  }
  
  // 4. NEW: Content value assessment (max 25 points)
  // This looks for signs of substantive news versus promotional content
  let contentValueScore = 0;
  
  // Check for funding details (amounts, investors)
  const fundingPatterns = [
    // Funding amount patterns like $5M, €10 million, etc.
    /\$\d+(\.\d+)?(\s?[mMbB]illion)?/,
    /€\d+(\.\d+)?(\s?[mMbB]illion)?/,
    /\d+(\.\d+)?\s?[mMbB]illion\s?\$|€|£/,
    /raised?\s+\d+/i,
    /funding|investment|round|seed|series [a-c]/i
  ];
  
  // Check if article contains funding information
  let hasFundingInfo = false;
  for (const pattern of fundingPatterns) {
    if (pattern.test(title + content)) {
      hasFundingInfo = true;
      contentValueScore += 15; // Major boost for funding news
      break;
    }
  }
  
  // Check for market analysis (trends, competition, growth)
  const marketAnalysisPatterns = [
    /market|industry|sector/i,
    /competiti(ve|on)/i,
    /growing|growth|expand/i,
    /trend|future|forecast/i,
    /analysis|report|data shows/i
  ];
  
  let hasMarketAnalysis = false;
  for (const pattern of marketAnalysisPatterns) {
    if (pattern.test(title + content)) {
      hasMarketAnalysis = true;
      contentValueScore += 10; // Good boost for market analysis
      break;
    }
  }
  
  // Detect promotional content (reduce score)
  const promotionalPatterns = [
    /is coming to/i,
    /join us/i,
    /register for/i,
    /don't miss/i,
    /sign up/i,
    /limited spots/i,
    /early bird/i,
    /special offer/i
  ];
  
  for (const pattern of promotionalPatterns) {
    if (pattern.test(title + content)) {
      contentValueScore -= 15; // Significant penalty for promotional content
      break;
    }
  }
  
  // Give bonus points for specific achievements/milestones
  const milestonePatterns = [
    /acquisition|acquired|merger/i,
    /IPO|public offering/i,
    /unicorn|billion.+valuation/i,
    /breakthrough|milestone/i,
    /launched|releasing|announces/i
  ];
  
  for (const pattern of milestonePatterns) {
    if (pattern.test(title + content)) {
      contentValueScore += 12; // Bonus for major business milestones
      break;
    }
  }
  
  // Cap content value score
  score += Math.min(Math.max(0, contentValueScore), MAX_CONTENT_VALUE_SCORE);
  
  // 5. Additional category-specific boosts
  
  // For Portuguese news, boost if multiple Portugal references
  if (category === 'pt_tech') {
    const ptMatches = (title + content).match(/portug|porto|lisbo[an]/gi);
    if (ptMatches && ptMatches.length > 2) {
      score += 15; // Bonus for multiple Portugal references
    }
  }
  
  // Add logging to help diagnose scoring decisions
  const scoreComponents = {
    titleMatch: Math.min(titleMatchScore, MAX_TITLE_MATCH_SCORE),
    contentMatch: Math.min(contentMatchScore, MAX_CONTENT_MATCH_SCORE),
    source: sourceName.includes(Object.keys(highQualitySources).find(s => sourceName.includes(s)) || '') ? 
      highQualitySources[Object.keys(highQualitySources).find(s => sourceName.includes(s)) || ''] || 0 : 0,
    length: content ? Math.min(MAX_LENGTH_SCORE, Math.log(Math.max(100, content.length)) * 1.5) : 0,
    contentValue: Math.min(Math.max(0, contentValueScore), MAX_CONTENT_VALUE_SCORE),
    categoryBoost: 0
  };
  
  // Add category boost to components for tracking
  if (category === 'pt_tech') {
    const ptMatches = (title + content).match(/portug|porto|lisbo[an]/gi);
    if (ptMatches && ptMatches.length > 2) {
      scoreComponents.categoryBoost = 15;
    }
  }
  
  // Save score components to the article for debugging
  article._scoreDetails = scoreComponents;
  
  return score;
}

/**
 * Generate a concise AI summary for an individual article
 */
async function generateArticleSummary(article, env) {
  try {
    // Extract article content
    const title = article.title || '';
    const content = article.contentSnippet || article.content || '';
    
    if (!content) {
      return 'No content available for this article.\nNo additional details found.\nCheck the original source for more information.';
    }
    
    // Create a prompt for the AI model with explicit formatting instructions
    const prompt = `Summarize this article in EXACTLY 3 short sentences. Each sentence should be on its own line separated by a line break (\\n).
    
Title: ${title}

Content: ${content.substring(0, 1000)}

IMPORTANT RULES:
1. Do NOT repeat the title or rephrase it in your summary
2. Focus on details and information NOT found in the title
3. Provide additional context and specific information from the article
4. Each sentence MUST offer new information beyond what's in the title
5. Format your response with exactly 3 sentences, each on its own line`;
    
    // Use the Hugging Face endpoint
    const endpoint = env.HUGGINGFACE_ENDPOINT || AI_CONFIG.endpoint;
    const apiKey = env.HUGGINGFACE_API_KEY;
    
    if (!apiKey) {
      console.log('No Hugging Face API key - using fallback for article summary');
      return createFallbackArticleSummary(content);
    }
    
    // Call the model
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        inputs: prompt,
        parameters: {
          max_new_tokens: 200,  // Limit to short summary
          temperature: 0.7
        }
      })
    });
    
    if (!response.ok) {
      console.warn(`AI summary generation failed with status ${response.status}`);
      return createFallbackArticleSummary(content);
    }
    
    // Process the response
    const data = await response.json();
    let summaryText = '';
    
    // Handle different response formats
    if (Array.isArray(data) && data[0] && data[0].generated_text) {
      summaryText = data[0].generated_text;
    } else if (typeof data === 'object' && data.generated_text) {
      summaryText = data.generated_text;
    } else if (Array.isArray(data) && data[0] && data[0].summary_text) {
      summaryText = data[0].summary_text;
    } else {
      console.warn('Unexpected AI response format, using fallback');
      return createFallbackArticleSummary(content);
    }
    
    // Clean up the summary - this needs to be more robust
    let cleanSummary = '';
    
    // First, strip the prompt completely
    cleanSummary = summaryText.replace(prompt, '').trim();
    
    // Clean up common artifacts from AI responses
    cleanSummary = cleanSummary
      // Remove any remaining instructions or formatting directives
      .replace(/Summarize this article in.*?sentences?\.?/gi, '')
      .replace(/Each sentence should be.*?(line|break).*?\./gi, '')
      .replace(/separated by a line break.*?\./gi, '')
      .replace(/IMPORTANT RULES:.*?line/gs, '')
      .replace(/Do NOT repeat the title.*?summary\.?/gi, '')
      .replace(/Focus on details.*?title\.?/gi, '')
      .replace(/Provide additional context.*?article\.?/gi, '')
      .replace(/Each sentence MUST.*?title\.?/gi, '')
      .replace(/Format your response.*?line\.?/gi, '')
      .replace(/Title:.*?\n/gi, '')
      .replace(/Content:.*?\n/gi, '')
      // Remove numbered lists (sometimes AI outputs "1. First point" etc.)
      .replace(/^\d+\.\s*/gm, '')
      // Remove any remnants of the format instructions
      .replace(/Sentence \d+\.?\s*/gi, '')
      .trim();
      
    // Additional cleanup for specific phrases that might appear at the beginning of lines
    cleanSummary = cleanSummary
      .replace(/^separated by a line break.*?\./gm, '')
      .replace(/^Do NOT repeat the title.*?\./gm, '')
      .replace(/^Each sentence.*?\./gm, '')
      .replace(/^Format your response.*?\./gm, '')
      .trim();
    
    // Extract just paragraphs or sentences, ignoring any other metadata
    const sentenceMatches = cleanSummary.match(/[^.!?]+[.!?]+/g) || [];
    const lineMatches = cleanSummary.split('\n').filter(line => line.trim().length > 0);
    
    // If we have clear sentences, use those
    if (sentenceMatches.length >= 3) {
      cleanSummary = sentenceMatches.slice(0, 3).join('\n');
    } 
    // If we have clear line breaks, use those
    else if (lineMatches.length >= 3) {
      cleanSummary = lineMatches.slice(0, 3).join('\n');
    }
    // Otherwise, use what we've cleaned so far
    
    // Make sure we have 3 lines of content
    const finalLines = cleanSummary.split('\n').filter(line => line.trim().length > 0);
    
    if (finalLines.length < 3) {
      // Not enough content, add generic informative sentences
      const genericSentences = [
        `The article discusses implications for business and technology sectors.`,
        `Several key market factors are mentioned in the detailed report.`,
        `Industry experts provide analysis on potential future developments.`,
        `Multiple stakeholders are impacted according to the source.`,
        `This development builds on previous industry trends.`
      ];
      
      // Add generic sentences until we have 3
      let result = [...finalLines];
      while (result.length < 3) {
        const randomIndex = Math.floor(Math.random() * genericSentences.length);
        result.push(genericSentences[randomIndex]);
        // Remove used sentence to avoid duplicates
        genericSentences.splice(randomIndex, 1);
      }
      
      cleanSummary = result.join('\n');
    } else if (finalLines.length > 3) {
      // Too many lines, keep just 3
      cleanSummary = finalLines.slice(0, 3).join('\n');
    }
    
    // Final sanity check to make sure we don't have the title or metadata in the output
    if (cleanSummary.includes(title) || 
        cleanSummary.toLowerCase().includes('summarize this article') ||
        cleanSummary.toLowerCase().includes('title:') ||
        cleanSummary.toLowerCase().includes('content:')) {
      console.warn('AI output still contains artifacts, using simplified version');
      return createFallbackArticleSummary(content);
    }
    
    return cleanSummary;
    
  } catch (error) {
    console.error('Error generating article summary:', error);
    return createFallbackArticleSummary(article.contentSnippet || article.content || '');
  }
}

/**
 * Create a simple fallback summary when AI is unavailable
 */
function createFallbackArticleSummary(content) {
  if (!content) {
    return 'No content available for this article.\nNo additional details found.\nCheck the original source for more information.';
  }
  
  // Clean up the content
  const cleanContent = content.replace(/<[^>]*>/g, '')
                             .replace(/\s+/g, ' ')
                             .trim();
  
  // Try to extract meaningful sentences
  let sentences = cleanContent.match(/[^.!?]+[.!?]+/g) || [];
  let summary = '';
  
  if (sentences.length >= 3) {
    // Take first 3 sentences
    summary = sentences.slice(0, 3).join('\n');
  } else {
    // Not enough sentences, take what we have and add placeholders
    while (sentences.length < 3) {
      sentences.push(`Additional information available in the original article.`);
    }
    summary = sentences.slice(0, 3).join('\n');
  }
  
  return summary;
}

/**
 * Create a report based on the top articles from each category
 * and incorporate any insights from the model summary
 */
async function createReportFromTopArticles(groupedArticles, modelSummary, env) {
  console.log('Creating report from top articles with model guidance');
  
  // Initialize the report structure
  const report = {
    pt_tech: [],
    global_tech: []
  };
  
  // Process each category
  for (const category in groupedArticles) {
    const articles = groupedArticles[category];
    
    // Skip empty categories
    if (!articles || articles.length === 0) {
      console.log(`Category ${category} has no articles`);
      continue;
    }
    
    // Score and rank articles by relevance
    const scoredArticles = articles.map(article => ({
      article,
      score: article.relevanceScore || calculateRelevanceScore(article, category)
    }));
    
    // Sort by relevance score (highest first)
    scoredArticles.sort((a, b) => b.score - a.score);
    
    // Log scores for ALL articles for debugging
    console.log(`\nALL articles for ${category} (sorted by relevance):`);
    scoredArticles.forEach((item, index) => {
      // Log score details for each article
      const article = item.article;
      const source = article.source || 'Unknown source';
      const pubDate = article.pubDate || article.isoDate || 'Unknown date';
      const url = article.originalLink || article.link || 'No URL';
      
      console.log(`  ${index+1}. Score: ${item.score.toFixed(1)} - ${item.article.title}`);
      console.log(`     Source: ${source} | Date: ${new Date(pubDate).toLocaleDateString()}`); 
      console.log(`     URL: ${url.substring(0, 80)}...`);
      
      // Display score breakdown if available
      if (article._scoreDetails) {
        const details = article._scoreDetails;
        console.log(`     Score breakdown: ` + 
          `Title(${details.titleMatch.toFixed(1)}) + ` +
          `Content(${details.contentMatch.toFixed(1)}) + ` +
          `Source(${details.source.toFixed(1)}) + ` +
          `Length(${details.length.toFixed(1)}) + ` +
          `Value(${details.contentValue.toFixed(1)}) + ` +
          `Boost(${details.categoryBoost.toFixed(1)})`
        );
        
        // If promotional pattern matched, note it
        if (details.contentValue < 0) {
          console.log(`     Note: Promotional content detected (-15 points)`);
        }
        
        // If funding info detected, note it
        if (details.contentValue >= 15) {
          console.log(`     Note: Funding or significant business news detected (+15 points)`);
        }
      }
      
      // If the article has a finalCategory, indicate if it was categorized correctly
      if (article.finalCategory && article.finalCategory !== category) {
        console.log(`     Note: Originally from category ${article.finalCategory} but best fit for ${category}`);
      }
      
      if (article.sourceCategory && article.sourceCategory !== 'general') {
        console.log(`     Feed category: ${article.sourceCategory}`);
      }
    });
    
    // Select top articles by relevance score for the report
    const topArticles = scoredArticles
      .slice(0, Math.min(3, scoredArticles.length))
      .map(item => item.article);
    
    // Process articles for the report and generate AI summaries
    for (const article of topArticles) {
      // Extract content for summary
      const title = article.title;
      const link = article.originalLink || article.link;
      const source = article.source;
      
      // Generate AI summary for this article
      const summary = await generateArticleSummary(article, env);
      
      // For all categories (events category removed)
      report[category].push({
        headline: title,
        details: summary,
        link: link,
        source: source,
        relevanceScore: article.relevanceScore
      });
    }
  }
  
  // Create an overview of the selected articles
  console.log('\n=== Final Report Content Overview ===');
  for (const category in report) {
    console.log(`\n${category.toUpperCase()} (${report[category].length} articles):`);
    report[category].forEach((item, i) => {
      const title = item.headline || item.name || 'Untitled';
      const score = item.relevanceScore ? `[score: ${item.relevanceScore.toFixed(1)}]` : '';
      console.log(`  ${i+1}. ${title} ${score}`);
    });
  }
  
  // If a category is empty, add placeholder
  if (report.pt_tech.length === 0) {
    report.pt_tech.push({
      headline: "No recent Portuguese tech news found",
      details: "We couldn't find any recent Portuguese tech news in our feeds.",
      link: "https://www.portugaltechnews.com/"
    });
  }
  
  if (report.global_tech.length === 0) {
    report.global_tech.push({
      headline: "No recent global tech news found",
      details: "We couldn't find any recent global tech news in our feeds.",
      link: "https://news.ycombinator.com/"
    });
  }
  
  return report;
}

/**
 * Generate a simple report without using AI when the API call fails
 */
function generateFallbackReport(groupedArticles, env) {
  console.log('Using fallback report generator with actual articles');
  
  // Just use the createReportFromTopArticles function
  return createReportFromTopArticles(groupedArticles, null, env);
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
    .news-link {
      margin-top: 5px;
      font-size: 0.9em;
    }
    .news-link a {
      color: #0066cc;
      text-decoration: none;
    }
    .news-link a:hover {
      text-decoration: underline;
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
  
  // Debug check - what sections and contents do we have?
  console.log('Email rendering - report sections:', Object.keys(report));
  const ptCount = report.pt_tech ? report.pt_tech.length : 0;
  const globalCount = report.global_tech ? report.global_tech.length : 0;
  console.log(`Email rendering - section counts: PT=${ptCount}, Global=${globalCount}`);
  
  // Portuguese Tech Scene section
  html += `
  <h2>🇵🇹 Portuguese Tech Scene</h2>`;
  
  if (report.pt_tech && report.pt_tech.length > 0) {
    report.pt_tech.forEach(item => {
      html += `
  <div class="news-item">
    <div class="news-headline">${item.headline || 'Portuguese Tech News'}</div>
    <div class="news-details">${item.details || 'Details not available'}</div>`;
      
      // Add link if available
      if (item.link) {
        html += `
    <div class="news-link"><a href="${item.link}" target="_blank">Read more →</a></div>`;
      }
      
      html += `
  </div>`;
    });
  } else {
    html += `
  <div class="news-item">
    <div class="news-headline">Portuguese Tech Updates</div>
    <div class="news-details">The Portuguese tech scene continues to evolve. Check back for specific updates in future reports.</div>
  </div>`;
  }
  
  // Global Tech News section
  html += `
  <h2>🌐 Global Tech News</h2>`;
  
  if (report.global_tech && report.global_tech.length > 0) {
    report.global_tech.forEach(item => {
      html += `
  <div class="news-item">
    <div class="news-headline">${item.headline || 'Global Tech News'}</div>
    <div class="news-details">${item.details || 'Details not available'}</div>`;
      
      // Add link if available
      if (item.link) {
        html += `
    <div class="news-link"><a href="${item.link}" target="_blank">Read more →</a></div>`;
      }
      
      html += `
  </div>`;
    });
  } else {
    html += `
  <div class="news-item">
    <div class="news-headline">Global Tech Trends</div>
    <div class="news-details">Technology continues to advance globally. More specific updates will be included in future reports.</div>
  </div>`;
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
  
  // Portuguese Tech Scene section
  text += `🇵🇹 PORTUGUESE TECH SCENE\n`;
  text += `-------------------------\n\n`;
  
  if (report.pt_tech && report.pt_tech.length > 0) {
    report.pt_tech.forEach(item => {
      text += `* ${item.headline || 'Portuguese Tech News'}\n`;
      text += `  ${item.details || 'Details not available'}\n`;
      if (item.link) {
        text += `  Link: ${item.link}\n`;
      }
      text += `\n`;
    });
  } else {
    text += `* Portuguese Tech Updates\n`;
    text += `  The Portuguese tech scene continues to evolve. Check back for specific updates in future reports.\n\n`;
  }
  
  // Global Tech News section
  text += `🌐 GLOBAL TECH NEWS\n`;
  text += `-------------------------\n\n`;

  if (report.global_tech && report.global_tech.length > 0) {
    report.global_tech.forEach(item => {
      text += `* ${item.headline || 'Global Tech News'}\n`;
      text += `  ${item.details || 'Details not available'}\n`;
      if (item.link) {
        text += `  Link: ${item.link}\n`;
      }
      text += `\n`;
    });
  } else {
    text += `* Global Tech Trends\n`;
    text += `  Technology continues to advance globally. More specific updates will be included in future reports.\n\n`;
  }
  
  text += `---------------------------\n`;
  text += `Porto Tech News - Generated at ${new Date().toISOString()}\n`;

  return text;
}

/**
 * Send a report via email
 */
async function sendReport(report, date, env) {
  const email = {
    to: 'recipient@example.com', // Replace with actual recipient email
    subject: `Porto Tech News - ${date}`,
    text: renderTextEmail(report, date),
    html: renderHtmlEmail(report, date)
  };

  const emailProvider = EMAIL_PROVIDERS[EMAIL_PROVIDER];
  if (!emailProvider) {
    throw new Error(`Unknown email provider: ${EMAIL_PROVIDER}`);
  }

  const apiKey = env.EMAIL_API_KEY;
  if (!apiKey) {
    throw new Error('No email API key provided');
  }

  const endpoint = emailProvider.endpoint;
  const headers = emailProvider.headers(apiKey);
  const payload = emailProvider.formatPayload(env.EMAIL_FROM, email.to, email.subject, email);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: headers,
    body: payload
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Email sending failed:', errorText);
    throw new Error(`Email sending failed with status ${response.status}: ${errorText}`);
  }

  console.log('Email sent successfully');
}