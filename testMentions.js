const { TwitterApi } = require('twitter-api-v2');

const twitterClient = new TwitterApi({
  appKey: 'YOUR_TWITTER_API_KEY',
  appSecret: 'YOUR_TWITTER_API_SECRET_KEY',
  accessToken: 'YOUR_TWITTER_ACCESS_TOKEN',
  accessSecret: 'YOUR_TWITTER_ACCESS_TOKEN_SECRET',
});

async function testMentions() {
  try {
    const mentions = await twitterClient.v2.userMentionTimeline('YOUR_TWITTER_USER_ID', {
      max_results: 5,
      'tweet.fields': 'author_id',
    });
    console.log('Mentions:', mentions.data);
  } catch (error) {
    console.error('Error fetching mentions:', error);
  }
}

testMentions();
