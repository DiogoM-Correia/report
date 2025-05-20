# Porto Tech News

A serverless tech news aggregator for Porto/Portugal, powered by Cloudflare Workers.

## Features

- 📰 Fetches tech news from multiple RSS sources
- 🤖 Summarizes articles using Hugging Face AI
- 📊 Categorizes news into investments, Portuguese news, global news, and events
- 📧 Delivers daily reports via email
- ⏱️ Runs on a daily schedule via Cloudflare Workers
- 🔄 Deduplicates articles to avoid repeats

## Setup Instructions

### Prerequisites

- Node.js and npm installed
- Cloudflare account
- Hugging Face account (free)
- SendGrid account (free tier available)

### Installation

1. Clone this repository
2. Install dependencies:
   ```
   npm install
   ```

3. Copy the environment template to create your development variables:
   ```
   cp env.template .dev.vars
   see results -> http://127.0.0.1:8787/latest-report?format=html
   ```

4. Fill in the required values in `.dev.vars`:
   - `EMAIL_API_KEY`: Your SendGrid API key
   - `EMAIL_FROM`: Your verified sender email in SendGrid
   - `EMAIL_TO`: Email address to receive reports
   - `HUGGINGFACE_API_KEY`: API token from your Hugging Face account
   - `FEED_LIST`: (Optional) Comma-separated list of RSS feed URLs

### Setting up Cloudflare Workers

1. Login to Cloudflare:
   ```
   npx wrangler login
   ```

2. Create KV namespaces for storage:
   ```
   npx wrangler kv:namespace create SEEN_ARTICLES
   npx wrangler kv:namespace create REPORTS
   ```

3. Update the `wrangler.toml` file with your namespace IDs from step 2

4. Upload the secrets to Cloudflare:
   ```
   npx wrangler secret put EMAIL_API_KEY
   npx wrangler secret put EMAIL_FROM
   npx wrangler secret put EMAIL_TO
   npx wrangler secret put HUGGINGFACE_API_KEY
   ```

### Local Development

Run the worker locally:
```
npm start
```

Test the report generation:
```
curl -X POST http://localhost:8787/run-report
```

### Deployment

Deploy to Cloudflare:
```
npm run deploy
```

## Configuration

### RSS Feeds

Edit the `DEFAULT_FEEDS` array in `src/index.js` or set the `FEED_LIST` environment variable to customize the news sources.

### Report Schedule

Edit the cron schedule in `wrangler.toml` to change when reports are generated and sent.

## Troubleshooting

- **Email Errors**: Ensure your SendGrid sender identity is verified
- **AI Errors**: Check your Hugging Face API key and model status
- **Empty Reports**: Adjust the recency filter or check RSS feed validity

## License

ISC 