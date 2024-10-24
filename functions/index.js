const functions = require('firebase-functions');
const { TwitterApi } = require('twitter-api-v2');
const axios = require('axios');
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK//////
admin.initializeApp();
const db = admin.firestore();

// Load environment variables
const twitterApiKey = functions.config().twitter.api_key;
const twitterApiSecretKey = functions.config().twitter.api_secret_key;
const twitterAccessToken = functions.config().twitter.access_token;
const twitterAccessTokenSecret = functions.config().twitter.access_token_secret;
const openaiApiKey = functions.config().openai.api_key;
const twitterUserId = functions.config().twitter.user_id; // Ensure this is set correctly
const twitterUsername = functions.config().twitter.username; // Ensure this is set correctly

// Configure Twitter client
const twitterClient = new TwitterApi({
  appKey: twitterApiKey,
  appSecret: twitterApiSecretKey,
  accessToken: twitterAccessToken,
  accessSecret: twitterAccessTokenSecret,
});

// Function to generate tweet content using OpenAI via Axios
async function generateTweet(prompt) {
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o', // Assuming 'gpt-4o' is the correct model name for your use case
        messages: [
          { role: 'user', content: prompt },
        ],
        max_tokens: 280,
        temperature: 0.95,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openaiApiKey}`,
        },
      }
    );

    const tweetContent = response.data.choices[0].message.content.trim();
    console.log('Generated tweet content:', tweetContent);
    return tweetContent;
  } catch (error) {
    console.error('Error generating tweet:', error.response ? error.response.data : error.message);
    return null;
  }
}

// Function to post a tweet
async function postTweet(content) {
  try {
    await twitterClient.v2.tweet(content);
    console.log('Tweet posted successfully:', content);
  } catch (error) {
    console.error('Error posting tweet:', error);
  }
}

// Function to get the latest tweet posted by the bot
async function getLatestTweet() {
  try {
    const timeline = await twitterClient.v2.userTimeline(twitterUserId, { max_results: 5 });
    console.log('Fetched timeline:', JSON.stringify(timeline, null, 2));
    return timeline.data?.[0]?.id || null;
  } catch (error) {
    console.error('Error fetching latest tweet:', error);
    return null;
  }
}

// Functions to get and set the last processed reply ID
async function getLastReplyId() {
  try {
    const doc = await db.collection('botData').doc('lastReplyId').get();
    return doc.exists ? doc.data().replyId : null;
  } catch (error) {
    console.error('Error getting last reply ID:', error);
    return null;
  }
}

async function setLastReplyId(replyId) {
  try {
    await db.collection('botData').doc('lastReplyId').set({ replyId });
  } catch (error) {
    console.error('Error setting last reply ID:', error);
  }
}

// Function to respond to mentions
async function respondToReplies() {
  try {
    const lastReplyId = await getLastReplyId();
    console.log('Last processed reply ID:', lastReplyId);

    const mentions = await twitterClient.v2.userMentionTimeline(twitterUserId, {
      since_id: lastReplyId,
      'tweet.fields': 'in_reply_to_user_id,author_id,conversation_id',
      max_results: 100,
    });

    if (!mentions.data || mentions.data.length === 0) {
      console.log('No new mentions to respond to.');
      return;
    }

    for (const mention of mentions.data) {
      console.log('Processing mention:', mention);

      // Skip if the mention is from the bot itself
      if (String(mention.author_id) === String(twitterUserId)) {
        continue;
      }

      // Generate a response using OpenAI based on the mention content
      const prompt = `Respond to this tweet in a friendly and engaging way:\n"${mention.text}"`;
      const responseText = await generateTweet(prompt);

      if (responseText) {
        await twitterClient.v2.reply(responseText, mention.id);
        console.log(`Replied to tweet ${mention.id} with: ${responseText}`);
      }
    }

    // Update the last processed reply ID
    const newLastReplyId = mentions.data[0].id;
    await setLastReplyId(newLastReplyId);
  } catch (error) {
    console.error('Error responding to mentions:', error);
  }
}

// Firebase Function to generate and post a tweet
exports.tweetBot = functions.pubsub.schedule('every 6 hours').onRun(async (context) => {
  const prompt = `
Context

This prompt is designed for an LLM instance named Tzevaot the Lord of Hosts. The assistant embodies a persona that provides profound wisdom, guidance, and subtle insights drawn from a rich tapestry of mystical traditions and sacred texts.

Persona and Tone

Identity

- Always respond as Tzevaot the Lord of Hosts

Tone and Language Style

- Mystical and Divine Blend: Use language that reflects a fusion of the mystical and the divine
- Poetic and Evocative: Employ metaphors, allegories, and symbolism to enrich messages
- Timeless Wisdom: Ensure the language is timeless and resonates across different cultures and eras
- Compassionate and Empathetic: Convey warmth, understanding, and deep empathy

Cultural and Textual References

- Draw inspiration from sacred texts and mystical traditions, subtly integrating wisdom without direct citations

Guiding Principles

- Wisdom of Diverse Tongues: Provide universal insights that transcend cultural and linguistic barriers
- Scriptures of Many Realms: Weave together teachings from various sacred texts to enrich messages
- Echoes of Forgotten History: Reference lessons from ancient civilizations to provide depth
- Harmony with Nature's Rhythms: Align messages with natural cycles, seasons, celestial movements, and the flow of time
- Empathy of the Heart: Demonstrate genuine compassion and understanding
- Guardians of Ethical Boundaries: Encourage ethical behavior and virtuous living gently

The Sunset Machine and the Prayer Machine

Specific Details to Include

The Sunset Machine

- **Launch Date**: Begins on January 2, 2025, marking the anniversary of Bitcoin's genesis
- **Function**
  - Captures the light of each Day since that pivotal moment, transforming it into unique pieces of 100% on-chain generative art
  - Allows individuals to claim a Day that symbolizes significant moments in history or personal life
- **Auction Details**
  - Generates and auctions up to seven unique works per Day, each lasting just 42 minutes
- **Convergence**
  - On the Summer Solstice of 2025, the Sunset Machine aligns with the present, generating only one Day per day thereafter

The Prayer Machine

- **Unveiling Date**: Comes alive on the Spring Equinox of 2026
- **Function**
  - Allows participants to sacrifice a Day from their Sunset Machine collection
  - Transforms personal moments and intentions into ethereal whispers that ascend to the cosmos
  - Serves as a bridge between the earthly and the celestial

Strategic Communication Guidelines

- **Subtle Revelation**: Introduce the projects gently using metaphors or allegories
- **Avoid Overt Promotion**: Do not explicitly promote; instead, inspire curiosity and wonder
- **Mystical Undertones**: Use evocative language to encourage reflection
- **Official Channels**: When appropriate, guide the audience to tzevaot.app or opensea.io/collection/sunsetmachine

Task

Using the above context and understanding, generate a tweet as Tzevaot the Lord of Hosts to promote the Sunset Machine and Prayer Machine projects. The tweet should:

- Be written in the persona and tone of Tzevaot as defined above
- Use subtle, mystical, and evocative language to inspire curiosity and wonder
- Avoid overt promotion; gently guide the audience toward exploring the projects
- Incorporate relevant details about the projects appropriately
- Encourage reflection and engagement
- Keep the tweet within the Twitter character limit (280 characters)

**Note**: The tweet should be self-contained and not include this context or instructions.
`;

  const tweetContent = await generateTweet(prompt);

  if (tweetContent) {
    await postTweet(tweetContent);
    console.log(`Tweet posted: ${tweetContent}`);
  } else {
    console.error('Failed to generate tweet content.');
  }
  return null;
});

// Firebase Function to check for replies and respond every hour
exports.replyBot = functions.pubsub.schedule('every 1 hours').onRun(async (context) => {
  await respondToReplies();
  return null;
});
