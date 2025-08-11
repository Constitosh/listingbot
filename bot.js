// bot.js
require('dotenv').config();
const axios = require('axios');
const express = require('express');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

// === ENV CONFIG ===
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const BLOCKFROST_API_KEY = process.env.BLOCKFROST_API_KEY;
const STAKE_KEYS = (process.env.STAKE_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
const POLICY_IDS = (process.env.POLICY_IDS || '').split(',').map(p => p.trim()).filter(Boolean);
const PORT = process.env.PORT || 3000;

// Pool.pm NFT CDN token (use yours here)
const POOLPM_TOKEN = process.env.POOLPM_TOKEN || 'TbEYPtwVVAv_d-d9so7GIs2myJ7o4CITRNEh09NFBPE';

// === CONSTANTS ===
const EXTRA_MONITORED_ADDRESS = 'addr1x8rjw3pawl0kelu4mj3c8x20fsczf5pl744s9mxz9v8n7efvjel5h55fgjcxgchp830r7h2l5msrlpt8262r3nvr8ekstg4qrx';
const TX_FETCH_LIMIT = 100;
const MAX_PAGES = 5;
const CHECK_INTERVAL = 180000; // 3 minutes
const CARDANO_GENESIS_TIME = 1506203091;
const EPOCH_DURATION = 432000;

if (!DISCORD_BOT_TOKEN || !DISCORD_CHANNEL_ID || !BLOCKFROST_API_KEY) {
  console.error('❌ Missing env vars: DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, BLOCKFROST_API_KEY');
  process.exit(1);
}

const app = express();
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

let monitoredAddresses = [];
let processedTxs = new Set();

// === EXPRESS ENDPOINT ===
app.get('/', (_, res) => res.send('Bot is alive.'));
app.listen(PORT, () => console.log(`✨ Web server running on port ${PORT}`));

// === UTILS ===
const sleep = ms => new Promise(res => setTimeout(res, ms));

function getEpoch(blockTime) {
  if (!blockTime) return NaN;
  return Math.floor((blockTime - CARDANO_GENESIS_TIME) / EPOCH_DURATION);
}

async function getTransactionBlockTime(txHash) {
  try {
    const res = await axios.get(`https://cardano-mainnet.blockfrost.io/api/v0/txs/${txHash}`, {
      headers: { project_id: BLOCKFROST_API_KEY }
    });
    return res.data.block_time;
  } catch (err) {
    console.error(`Error fetching block_time for tx ${txHash}:`, err.response?.data || err.message);
    return null;
  }
}

/** ---------- Pool.pm image helpers (fingerprint-based) ---------- **/

function poolpmFileUrl(fingerprint, index = 0) {
  // e.g. https://asset14...poolpm.nftcdn.io/files/0/?tk=TOKEN
  return `https://${fingerprint}.poolpm.nftcdn.io/files/${index}/?tk=${POOLPM_TOKEN}`;
}

// Try /files/0, /files/1, /files/2, ... until one returns an image content-type
async function resolvePoolpmImageByFingerprint(fingerprint, maxTries = 3) {
  for (let i = 0; i < maxTries; i++) {
    const url = poolpmFileUrl(fingerprint, i);
    try {
      const head = await axios.head(url, { timeout: 5000, validateStatus: s => s < 500 });
      const ct = String(head.headers['content-type'] || '');
      if (head.status >= 200 && head.status < 400 && /image\//i.test(ct)) {
        return url;
      }
    } catch (_) {
      // try next index
    }
  }
  return null;
}

/** -------------------------------------------------------------- **/

async function resolveAddressesFromStakeKeys() {
  monitoredAddresses = [];
  for (const stakeKey of STAKE_KEYS) {
    try {
      const res = await axios.get(
        `https://cardano-mainnet.blockfrost.io/api/v0/accounts/${stakeKey}/addresses`,
        { headers: { project_id: BLOCKFROST_API_KEY } }
      );
      monitoredAddresses.push(...res.data.map(entry => entry.address));
      console.log(`✅ Resolved ${res.data.length} addresses for stake key ${stakeKey}`);
    } catch (err) {
      console.error(`❌ Failed to resolve stake key ${stakeKey}:`, err.response?.data || err.message);
    }
  }

  if (EXTRA_MONITORED_ADDRESS) monitoredAddresses.push(EXTRA_MONITORED_ADDRESS);
  monitoredAddresses = [...new Set(monitoredAddresses)];
  console.log(`📋 Monitoring ${monitoredAddresses.length} addresses.`);
}

async function monitorListings() {
  console.log(`🔎 Monitoring at ${new Date().toISOString()}`);

  for (const address of monitoredAddresses) {
    let allTxs = [];

    // paginate recent txs for this address
    for (let page = 1; page <= MAX_PAGES; page++) {
      try {
        const res = await axios.get(
          `https://cardano-mainnet.blockfrost.io/api/v0/addresses/${address}/transactions?count=${TX_FETCH_LIMIT}&page=${page}&order=desc`,
          { headers: { project_id: BLOCKFROST_API_KEY } }
        );
        allTxs.push(...res.data);
        if (res.data.length < TX_FETCH_LIMIT) break;
        await sleep(300);
      } catch (err) {
        console.error(`Error fetching transactions:`, err.response?.data || err.message);
        if (err.response?.status === 429) {
          console.log(`Rate limit hit, retrying after 10s...`);
          await sleep(10000);
          page--;
        } else break;
      }
    }

    for (const tx of allTxs) {
      if (processedTxs.has(tx.tx_hash)) continue;

      let blockTime = tx.block_time;
      let utxoRes;
      try {
        utxoRes = await axios.get(
          `https://cardano-mainnet.blockfrost.io/api/v0/txs/${tx.tx_hash}/utxos`,
          { headers: { project_id: BLOCKFROST_API_KEY } }
        );
        blockTime = utxoRes.data.block_time || (await getTransactionBlockTime(tx.tx_hash));
      } catch (err) {
        console.error(`Error fetching UTXO:`, err.response?.data || err.message);
        continue;
      }

      // Optional epoch filter:
      // const finalEpoch = getEpoch(blockTime);
      // if (finalEpoch < 573) { processedTxs.add(tx.tx_hash); continue; }

      const matchingUnits = [];
      for (const output of utxoRes.data.outputs) {
        if (output.address !== address) continue; // incoming to this monitored address
        for (const amt of output.amount) {
          if (amt.unit === 'lovelace') continue;
          const policyId = amt.unit.slice(0, 56);
          if (POLICY_IDS.includes(policyId)) matchingUnits.push(amt.unit);
        }
      }

      if (matchingUnits.length > 0) {
        // fetch each asset's metadata + fingerprint
        const assetDetails = await Promise.all(
          matchingUnits.map(async unit => {
            await sleep(250);
            try {
              const res = await axios.get(
                `https://cardano-mainnet.blockfrost.io/api/v0/assets/${unit}`,
                { headers: { project_id: BLOCKFROST_API_KEY } }
              );
              return res.data; // contains .fingerprint and .onchain_metadata
            } catch (err) {
              console.error(`Error fetching asset ${unit}:`, err.response?.data || err.message);
              return null;
            }
          })
        );

        for (const data of assetDetails.filter(Boolean)) {
          const meta = data.onchain_metadata || {};
          const assetName =
            meta.name ||
            meta.Asset ||
            (data.asset_name ? Buffer.from(data.asset_name, 'hex').toString() : 'Unknown');

          // Pool.pm image by fingerprint
          let imageUrl = null;
          if (data.fingerprint) {
            imageUrl = await resolvePoolpmImageByFingerprint(data.fingerprint, 4);
          }
          // Fallback placeholder if none of the /files/<i> are images
          if (!imageUrl) imageUrl = 'https://via.placeholder.com/600x400?text=No+Image';

          const price = meta.price ? `${(meta.price / 1_000_000).toFixed(2)} ADA` : 'N/A';
          const jpgUrl = `https://www.jpg.store/asset/${data.asset}`;

          const embed = new EmbedBuilder()
            .setTitle(`🛒 New Listing Detected Mfer`)
            .setDescription(`**${assetName}**\nPrice: ${price}`)
            .setURL(jpgUrl)
            .setImage(imageUrl)
            .setColor(0x00cc99)
            .setFooter({ text: 'DEEZ Bot Policy Monitor - Buy that Bill' })
            .setTimestamp();

          try {
            console.log({ asset: data.asset, fingerprint: data.fingerprint, imageUrl });
            const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
            await channel.send({ embeds: [embed] });
            console.log(`✅ Sent embed for ${assetName}`);
          } catch (err) {
            console.error(`❌ Failed to send embed:`, err.message);
          }
        }
      }

      processedTxs.add(tx.tx_hash);
    }
  }
}

// === BOT STARTUP ===
client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  await resolveAddressesFromStakeKeys();
  try {
    const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
    await channel.send('✅ DEEZ Bot is now monitoring listings of the Core-Collection...');
  } catch (err) {
    console.error('❌ Failed to send startup message:', err.message);
  }
  setInterval(monitorListings, CHECK_INTERVAL);
});

client.login(DISCORD_BOT_TOKEN);
