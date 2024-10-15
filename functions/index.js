const functions = require('firebase-functions');
const { Configuration, OpenAIApi } = require('openai');
const { TwitterApi } = require('twitter-api-v2');

// Load environment variables
const twitterApiKey = functions.config().twitter.api_key;
const twitterApiSecretKey = functions.config().twitter.api_secret_key;
const twitterAccessToken = functions.config().twitter.access_token;
const twitterAccessTokenSecret = functions.config().twitter.access_token_secret;
const openaiApiKey = functions.config().openai.api_key;

// Configure OpenAI
const configuration = new Configuration({
  apiKey: openaiApiKey,
});
const openai = new OpenAIApi(configuration);

// Configure Twitter
const twitterClient = new TwitterApi({
  appKey: twitterApiKey,
  appSecret: twitterApiSecretKey,
  accessToken: twitterAccessToken,
  accessSecret: twitterAccessTokenSecret,
});

// Function to generate tweet content using OpenAI
async function generateTweet(prompt) {
  try {
    const response = await openai.createCompletion({
      model: 'text-davinci-003', // Or another model if preferred
      prompt: prompt,
      max_tokens: 50, // Adjust as needed
      temperature: 0.7,
    });
    return response.data.choices[0].text.trim();
  } catch (error) {
    console.error('Error generating tweet:', error);
    return null;
  }
}

// Function to post a tweet
async function postTweet(content) {
  try {
    await twitterClient.v2.tweet(content);
    console.log('Tweet posted:', content);
  } catch (error) {
    console.error('Error posting tweet:', error);
  }
}

// Firebase Function to generate and post a tweet
exports.tweetBot = functions.pubsub.schedule('every 6 hours').onRun(async (context) => {
  const prompt = 'Write a motivational quote about learning new technologies.';
  const tweetContent = await generateTweet(prompt);

  if (tweetContent) {
    await postTweet(tweetContent);
    console.log(`Tweet posted: ${tweetContent}`);
  } else {
    console.error('Failed to generate tweet.');
  }
  return null;
});
