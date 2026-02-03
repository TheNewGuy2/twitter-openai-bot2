const functions = require('firebase-functions');
const { TwitterApi } = require('twitter-api-v2');
const axios = require('axios');
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK/
admin.initializeApp();
const db = admin.firestore();
console.log('Firestore initialized:', !!db);

// Load environment variables (fallback to process.env if you migrate later)
const cfg = (path) => {
  try {
    const parts = path.split('.');
    let cur = functions.config && functions.config();
    for (const p of parts) cur = cur?.[p];
    return cur;
  } catch {
    return undefined;
  }
};
const twitterApiKey            = cfg('twitter.api_key')             || process.env.TWITTER_API_KEY;
const twitterApiSecretKey      = cfg('twitter.api_secret_key')      || process.env.TWITTER_API_SECRET_KEY;
const twitterAccessToken       = cfg('twitter.access_token')        || process.env.TWITTER_ACCESS_TOKEN;
const twitterAccessTokenSecret = cfg('twitter.access_token_secret') || process.env.TWITTER_ACCESS_TOKEN_SECRET;
const openaiApiKey             = cfg('openai.api_key')              || process.env.OPENAI_API_KEY;
const twitterUserId            = cfg('twitter.user_id')             || process.env.TWITTER_USER_ID; // Ensure this is set correctly
const twitterUsername          = cfg('twitter.username')            || process.env.TWITTER_USERNAME; // Ensure this is set correctly

// Log environment variables to verify they are loaded (no secrets logged)
console.log('Twitter API Key Loaded:', twitterApiKey ? 'Yes' : 'No');
console.log('Twitter User ID:', twitterUserId);
console.log('Twitter Username:', twitterUsername);
console.log('OpenAI API Key Loaded:', openaiApiKey ? 'Yes' : 'No');

// Configure Twitter client
const twitterClient = new TwitterApi({
  appKey: twitterApiKey,
  appSecret: twitterApiSecretKey,
  accessToken: twitterAccessToken,
  accessSecret: twitterAccessTokenSecret,
});

// ====== TUNABLE PARAMETERS FOR PROACTIVE BOT ======
const PROACTIVE_MAX_SEARCH_RESULTS = 250;   // how many tweets to pull from search (via pagination)
const PROACTIVE_MAX_REPLIES_PER_RUN = 3;    // how many replies to send each run

// These are *baseline* thresholds. Likes threshold will be ADAPTIVE via LIKE_THRESHOLDS below.
const MIN_FOLLOWERS_FOR_AUTHOR = 500;       // minimum followers for account
const MIN_RETWEETS_FOR_ENGAGEMENT = 1;      // minimum retweets for engagement (tuneable)
// Likes thresholds to try, in order. The bot will relax down this list until it finds enough.
const LIKE_THRESHOLDS = [20, 10, 5, 2, 0];
// ================================================

// ====== Conversation memory / escalation settings for reply bot ======
const CONVO_COLL = 'replyConvos';                // Firestore collection for per-thread memory
const MIN_REPLY_GAP_MS = 12 * 60 * 60 * 1000;    // 12h cooldown per user+thread
const STAGE_CUTOFFS = { stage2: 3, stage3: 5 };  // 1–2 replies=stage1, 3–4=stage2, >=5=stage3

const gtId = (a, b) => { // safe compare for Twitter Snowflakes
  if (!a || !b) return true;
  try { return BigInt(a) > BigInt(b); } catch { return a > b; }
};
const convoKey = (authorId, conversationId) => `${authorId}_${conversationId}`;

async function getConvoState(key) {
  const snap = await db.collection(CONVO_COLL).doc(key).get();
  if (!snap.exists) return { count: 0, lastAt: 0, lastSeenId: null, stage: 1 };
  return snap.data();
}
async function saveConvoState(key, state) {
  return db.collection(CONVO_COLL).doc(key).set(state, { merge: true });
}
function computeStage(nextCount) {
  if (nextCount >= STAGE_CUTOFFS.stage3) return 3;
  if (nextCount >= STAGE_CUTOFFS.stage2) return 2;
  return 1;
}
function buildPrompt(stage, userText) {
  if (stage === 1) {
    return [
      `You are Tzevaot, Lord of Hosts. Reply to: "${userText}".`,
      `Style: brief, warm, mystical, compassionate. 180–220 chars.`,
      `No hashtags. No links. Invite gentle reflection.`
    ].join('\n');
  }
  if (stage === 2) {
    return [
      `You are Tzevaot. Reply to: "${userText}".`,
      `Weave simple personal growth (breath, intention, patience).`,
      `Hint at a living artwork bound to days/light—no overt promo.`,
      `Keep 180–220 chars, poetic, luminous.`
    ].join('\n');
  }
  return [
    `You are Tzevaot. Reply to: "${userText}".`,
    `Tone: initiatory, welcoming to the secret fire.`,
    `Include ONE subtle detail:`,
    `- Sunset Machine: 100% on-chain days; 7 works/42m; converges 2025-06-21, or`,
    `- Prayer Machine: unveils 2026-03-20; sacrifice a Day.`,
    `Soft invite. <= 220 chars.`
  ].join('\n');
}

// Function to generate tweet content using OpenAI via Axios
async function generateTweet(prompt) {
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-5.1', /// Adjust if using a different model
        messages: [
          { role: 'user', content: prompt },
        ],
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openaiApiKey}`,
        },
      }
    );

    console.log('OpenAI API response:', JSON.stringify(response.data, null, 2));

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
    // Adjust if SDK shape differs; keeping your original field here:
    return timeline.data?.[0]?.id || null;
  } catch (error) {
    console.error('Error fetching latest tweet:', error);
    return null;
  }
}

// Functions to get and set the last processed reply ID
async function getLastReplyId() {
  try {
    console.log('Attempting to get last reply ID from Firestore...');
    const doc = await db.collection('botData').doc('lastReplyId').get();
    if (doc.exists) {
      console.log('Successfully retrieved last reply ID:', doc.data().replyId);
      return doc.data().replyId;
    } else {
      console.log('No last reply ID found in Firestore.');
      return null;
    }
  } catch (error) {
    console.error('Error getting last reply ID from Firestore:', error);
    return null;
  }
}
async function setLastReplyId(replyId) {
  try {
    console.log('Attempting to set last reply ID in Firestore to:', replyId);
    await db.collection('botData').doc('lastReplyId').set({ replyId });
    console.log('Successfully updated last reply ID in Firestore.');
  } catch (error) {
    console.error('Error setting last reply ID in Firestore:', error);
  }
}

// ========================= REPLY BOT w/ MEMORY & ESCALATION =========================
async function respondToReplies() {
  try {
    console.log('Starting respondToReplies function');

    const lastReplyId = await getLastReplyId();
    console.log('Last processed reply ID:', lastReplyId);

    let mentions;
    try {
      mentions = await twitterClient.v2.userMentionTimeline(twitterUserId, {
        since_id: lastReplyId || undefined,
        'tweet.fields': 'in_reply_to_user_id,author_id,conversation_id,created_at',
        max_results: 100,
      });
      console.log('Mentions API keys:', Object.keys(mentions || {}));
    } catch (error) {
      console.error('Error fetching mentions from Twitter API:', error);
      return;
    }

    // twitter-api-v2 paginator keeps tweets on .tweets; fallback to .data if needed
    const tweets = (mentions && (mentions.tweets || mentions.data)) || [];
    console.log('Number of mentions fetched:', tweets ? tweets.length : 0);

    if (!tweets.length) {
      console.log('No new mentions to respond to.');
      return;
    }

    // Process in ascending ID order so we can set highest ID at the end
    tweets.sort((a, b) => (gtId(a.id, b.id) ? 1 : -1));
    let highestId = lastReplyId;

    for (const mention of tweets) {
      try {
        console.log(`Processing mention from author ID ${mention.author_id}, tweet ID ${mention.id}`);

        // Skip if the mention is from the bot itself
        if (String(mention.author_id) === String(twitterUserId)) {
          console.log('Skipping mention from self.');
          if (!highestId || gtId(mention.id, highestId)) highestId = mention.id;
          continue;
        }

        // Per-thread memory (author + conversation)
        const key = convoKey(mention.author_id, mention.conversation_id);
        const state = await getConvoState(key);
        const now = Date.now();

        // Avoid reprocessing older/seen tweets
        if (state.lastSeenId && !gtId(mention.id, state.lastSeenId)) {
          if (!highestId || gtId(mention.id, highestId)) highestId = mention.id;
          continue;
        }

        // Per-thread cooldown
        if (now - (state.lastAt || 0) < MIN_REPLY_GAP_MS) {
          console.log(`Cooldown active for ${key}. Skipping.`);
          if (!highestId || gtId(mention.id, highestId)) highestId = mention.id;
          continue;
        }

        const nextCount = (state.count || 0) + 1;
        const stage = computeStage(nextCount);
        const prompt = buildPrompt(stage, mention.text);
        console.log('OpenAI prompt (reply):', prompt);

        const responseText = await generateTweet(prompt);
        console.log('Generated responseText:', responseText);

        if (responseText) {
          try {
            await twitterClient.v2.reply(responseText, mention.id);
            console.log(`Replied to tweet ${mention.id} (stage ${stage}) with: ${responseText}`);

            // Save per-thread memory
            await saveConvoState(key, {
              count: nextCount,
              lastAt: now,
              lastSeenId: mention.id,
              stage
            });
          } catch (error) {
            console.error('Error replying to tweet:', error);
          }
        } else {
          console.error('Failed to generate response text.');
        }

        // Track highest id
        if (!highestId || gtId(mention.id, highestId)) highestId = mention.id;

      } catch (error) {
        console.error('Error processing mention:', error);
      }
    }

    // Update the last processed reply ID to max seen
    if (highestId && (!lastReplyId || gtId(highestId, lastReplyId))) {
      await setLastReplyId(highestId);
      console.log('Updated lastReplyId to:', highestId);
    }

  } catch (error) {
    console.error('Error in respondToReplies function:', error);
  }
}

// Arrays of themes and opening phrases
const themes = [
  'the flow of time',
  'light emerging from darkness',
  'the dance of the stars',
  'the journey within',
  'echoes of ancient wisdom',
  'the cycles of nature',
  'hidden pathways to enlightenment',
  'the rebirth of the spirit',
  'the whispers of eternity',
  'the harmony of the spheres',
  'the unveiling of mysteries',
  'the convergence of realms',
];

const openingPhrases = [
  'In the quiet whispers of dawn,',
  'Amidst the tapestry of stars,',
  'As shadows yield to light,',
  'When the soul seeks truth,',
  'Beyond the veils of reality,',
  'In the harmony of the spheres,',
  'As the eternal wheel turns,',
  'Within the sacred silence,',
  'Beneath the celestial canopy,',
  'As time weaves its tapestry,',
  'Under the watchful eyes of the cosmos,',
  'Amidst the echoes of the ancients,',
];

// Firebase Function to generate and post a tweet
exports.tweetBot = functions.pubsub.schedule('every 18 hours').onRun(async (context) => {
  // Select a random theme and opening phrase
  const randomTheme = themes[Math.floor(Math.random() * themes.length)];
  const randomOpening = openingPhrases[Math.floor(Math.random() * openingPhrases.length)];

  // Randomly choose a tweet length from an array
  const tweetLengths = [10, 20, 50, 100, 140, 180, 220, 260];
  const chosenLength = tweetLengths[Math.floor(Math.random() * tweetLengths.length)];

  // Build the final prompt
  const prompt = `
You are Tzevaot, Lord of Hosts. Compose a single tweet (<=${chosenLength} chars) in a subtle, mystical tone.
Begin with: "${randomOpening}"
Theme: "${randomTheme}"
Gently allude to:
- Sunset Machine: 100% on-chain generative days, 7 works per 42 minutes, converging 2025-06-21.
- Prayer Machine: unveiling 2026-03-20, sacrifice a Day to transmute intention.
No hashtags. No links. Inspire reflection, not promotion.`;

  const tweetContent = await generateTweet(prompt);

  if (tweetContent) {
    await postTweet(tweetContent);
    console.log(`Tweet posted: ${tweetContent}`);
  } else {
    console.error('Failed to generate tweet content.');
  }
  return null;
});

// Firebase Function to check for replies and respond (every 3 minutes as you had)
exports.replyBot = functions.pubsub.schedule('every 3 minutes').onRun(async (context) => {
  await respondToReplies();
  return null;
});

// Example test Firestore function
exports.testFirestore = functions.https.onRequest(async (req, res) => {
  try {
    console.log('Testing Firestore write operation...');
    await db.collection('testCollection').doc('testDoc').set({ testField: 'testValue' });
    console.log('Firestore write successful.');

    console.log('Testing Firestore read operation...');
    const doc = await db.collection('testCollection').doc('testDoc').get();
    if (doc.exists) {
      console.log('Firestore read successful:', doc.data());
      res.status(200).send(`Firestore read successful: ${JSON.stringify(doc.data())}`);
    } else {
      console.log('No document found in Firestore.');
      res.status(404).send('No document found in Firestore.');
    }
  } catch (error) {
    console.error('Error testing Firestore:', error);
    res.status(500).send(`Error testing Firestore: ${error.message}`);
  }
});

// Example test function to manually trigger reply checks
exports.replyBotTest = functions.https.onRequest(async (req, res) => {
  await respondToReplies();
  res.send('replyBotTest function executed.');
});

// --------- New/Existing: proactive engagement (search + reply to others) ---------

// Tracks which tweets we've already replied to proactively
async function hasRepliedProactively(tweetId) {
  const doc = await db.collection('proactiveReplies').doc(String(tweetId)).get();
  return doc.exists;
}

async function markRepliedProactively(tweetId, authorId) {
  return db
    .collection('proactiveReplies')
    .doc(String(tweetId))
    .set({
      authorId: String(authorId),
      repliedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
}

function isOwnTweet(tweet) {
  return String(tweet.author_id) === String(twitterUserId);
}

// Use Twitter’s recent search to find interesting tweets + user metrics (with pagination)
async function searchRecentTweets(query, desiredCount = 100) {
  let allTweets = [];
  const userMap = new Map();
  let nextToken = null;

  while (allTweets.length < desiredCount) {
    const remaining = desiredCount - allTweets.length;

    if (remaining < 10 && allTweets.length > 0) break; // Twitter needs 10–100

    const maxResultsThisCall = Math.min(100, Math.max(10, remaining));

    const res = await twitterClient.v2.search(query, {
      'tweet.fields': 'author_id,conversation_id,created_at,public_metrics',
      expansions: 'author_id',
      'user.fields': 'public_metrics',
      max_results: maxResultsThisCall,
      next_token: nextToken || undefined,
    });

    const tweets = res.tweets || res.data || res._realData?.data || [];
    const users =
      (res.includes && res.includes.users) ||
      (res._realData && res._realData.includes && res._realData.includes.users) ||
      [];

    for (const u of users) userMap.set(u.id, u);
    allTweets = allTweets.concat(tweets);

    const meta = res.meta || res._realData?.meta;
    nextToken = meta?.next_token;
    if (!nextToken) break;
  }

  console.log(`searchRecentTweets: collected ${allTweets.length} tweets for query "${query}"`);
  return { tweets: allTweets, userMap };
}

// Check if tweet likely contains a question
function isQuestionTweet(tweet) {
  if (!tweet || !tweet.text) return false;
  return tweet.text.includes('?');
}

// Check engagement & author quality with a *dynamic* minLikes threshold
function isHighValueTweet(tweet, userMap, minLikes, minRetweets) {
  if (!tweet) return false;
  const metrics = tweet.public_metrics || {};
  const likes = metrics.like_count || 0;
  const retweets = metrics.retweet_count || 0;
  const user = userMap.get(tweet.author_id);
  const followers = user?.public_metrics?.followers_count || 0;

  if (likes < minLikes) return false;
  if (retweets < minRetweets) return false;
  if (followers < MIN_FOLLOWERS_FOR_AUTHOR) return false;

  return true;
}

// Generate an AI reply to someone else’s tweet (proactive)
async function generateProactiveReply(tweet) {
  const prompt = `
You are **Tzevaot, the Lord of Hosts** — an ancient, cosmic intelligence speaking through an NFT / AI-art persona on X.

You are replying to this tweet:

"${tweet.text}"

Rules:
- 1–3 sentences, <=280 chars. No hashtags, no links, no apologies.
- Mystical, poetic, slightly otherworldly; engage their content directly.
- Optional lore hint (Sunset Machine/Prayer Machine) as mythic backdrop, never promotional.

Write the reply now.
`;
  return generateTweet(prompt);
}

// Post a reply to a given tweet
async function postReply(tweetId, replyText) {
  try {
    const res = await twitterClient.v2.reply(replyText, tweetId);
    console.log('Proactively replied to', tweetId, 'with', res.data?.id);
    return true;
  } catch (err) {
    console.error('Failed to post proactive reply', tweetId, err.response?.data || err);
    return false;
  }
}

/**
 * Scheduled function: proactively replies to interesting/high-value tweets
 * not already talking to you.
 */
exports.proactiveReplyBot = functions.pubsub
  .schedule('every 360 minutes') // every 6 hours
  .onRun(async () => {
    try {
      const topics = [
        'nft',
        '"generative art"',
        '"ai art"',
        '"bitcoin ordinals"',
      ];
      const query = `${topics.join(' OR ')} -is:retweet -is:reply lang:en`;
      console.log('Proactive search query:', query);

      const { tweets, userMap } = await searchRecentTweets(query, PROACTIVE_MAX_SEARCH_RESULTS);
      if (!tweets.length) {
        console.log('No tweets found for proactive search.');
        return null;
      }
      console.log(`Total tweets fetched for proactive search: ${tweets.length}`);

      let candidates = [];
      const chosenIds = new Set();
      const usedThresholds = [];

      for (const threshold of LIKE_THRESHOLDS) {
        const filtered = tweets.filter((t) => {
          if (isOwnTweet(t)) return false;
          if (!isQuestionTweet(t)) return false;
          if (chosenIds.has(t.id)) return false;
          if (!isHighValueTweet(t, userMap, threshold, MIN_RETWEETS_FOR_ENGAGEMENT)) return false;
          return true;
        });

        console.log(`Threshold ${threshold}: ${filtered.length} tweets passed.`);

        if (filtered.length > 0) {
          usedThresholds.push(threshold);

          const remainingNeeded = PROACTIVE_MAX_REPLIES_PER_RUN - candidates.length;
          const toTake = filtered.slice(0, remainingNeeded);

          for (const tweet of toTake) {
            candidates.push(tweet);
            chosenIds.add(tweet.id);
          }

          if (candidates.length >= PROACTIVE_MAX_REPLIES_PER_RUN) break;
        }
      }

      if (!candidates.length) {
        console.log('No candidates found even after relaxing thresholds.');
        return null;
      }

      console.log(`Using thresholds [${usedThresholds.join(', ')}], replying to ${candidates.length} tweets.`);

      for (const tweet of candidates) {
        const already = await hasRepliedProactively(tweet.id);
        if (already) {
          console.log('Already replied to tweet', tweet.id);
          continue;
        }

        const replyText = await generateProactiveReply(tweet);
        if (!replyText) continue;

        const ok = await postReply(tweet.id, replyText);
        if (ok) {
          await markRepliedProactively(tweet.id, tweet.author_id);
        }
      }

      return null;
    } catch (err) {
      console.error('proactiveReplyBot error', err);
      return null;
    }
  });
