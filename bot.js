require('dotenv').config();
const axios = require('axios');
const express = require('express');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

// === ENV CONFIG ===
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const BLOCKFROST_API_KEY = process.env.BLOCKFROST_API_KEY;
const STAKE_KEYS = (process.env.STAKE_KEYS || '').split(',').map(k => k.trim());
const POLICY_IDS = (process.env.POLICY_IDS || '').split(',').map(p => p.trim());
const PORT = process.env.PORT || 3000;

// === CONSTANTS ===
const EXTRA_MONITORED_ADDRESS = 'addr1x8rjw3pawl0kelu4mj3c8x20fsczf5pl744s9mxz9v8n7efvjel5h55fgjcxgchp830r7h2l5msrlpt8262r3nvr8ekstg4qrx';
const TX_FETCH_LIMIT = 100;
const MAX_PAGES = 5;
const CHECK_INTERVAL = 180000; // 3 minutes
const EPOCH_573_START_TIME = 1753739091;
const CARDANO_GENESIS_TIME = 1506203091;
const EPOCH_DURATION = 432000;

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

function ipfsToHttp(ipfs) {
  if (!ipfs) return 'https://via.placeholder.com/150?text=No+Image';
  if (Array.isArray(ipfs)) ipfs = ipfs[0];
  else if (typeof ipfs === 'object' && ipfs.url) ipfs = ipfs.url;
  if (typeof ipfs !== 'string') return 'https://via.placeholder.com/150?text=Invalid+Image';

  if (ipfs.startsWith('ipfs://')) return ipfs.replace('ipfs://', 'https://ipfs.io/ipfs/');
  if (ipfs.startsWith('http')) return ipfs;

  return 'https://via.placeholder.com/150?text=Unknown+Format';
}

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

  monitoredAddresses.push(EXTRA_MONITORED_ADDRESS);
  monitoredAddresses = [...new Set(monitoredAddresses)];
  console.log(`📋 Monitoring ${monitoredAddresses.length} addresses.`);
}

async function monitorListings() {
  console.log(`🔎 Monitoring at ${new Date().toISOString()}`);

  for (const address of monitoredAddresses) {
    let allTxs = [];

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
      const epoch = getEpoch(tx.block_time);
      if (processedTxs.has(tx.tx_hash) || epoch < 573) continue;

      let blockTime = tx.block_time;
      let utxoRes;
      try {
        utxoRes = await axios.get(
          `https://cardano-mainnet.blockfrost.io/api/v0/txs/${tx.tx_hash}/utxos`,
          { headers: { project_id: BLOCKFROST_API_KEY } }
        );
        blockTime = utxoRes.data.block_time || await getTransactionBlockTime(tx.tx_hash);
      } catch (err) {
        console.error(`Error fetching UTXO:`, err.response?.data || err.message);
        continue;
      }

      const finalEpoch = getEpoch(blockTime);
      if (finalEpoch < 573) continue;

      const matchingAssets = [];
      for (const output of utxoRes.data.outputs) {
        if (output.address !== address) continue;
        for (const asset of output.amount) {
          if (asset.unit === 'lovelace') continue;
          const policyId = asset.unit.slice(0, 56);
          if (POLICY_IDS.includes(policyId)) matchingAssets.push(asset.unit);
        }
      }

      if (matchingAssets.length > 0) {
        const assetDetails = await Promise.all(
          matchingAssets.map(async unit => {
            await sleep(300);
            try {
              const res = await axios.get(
                `https://cardano-mainnet.blockfrost.io/api/v0/assets/${unit}`,
                { headers: { project_id: BLOCKFROST_API_KEY } }
              );
              return res.data;
            } catch (err) {
              console.error(`Error fetching asset ${unit}:`, err.response?.data || err.message);
              return null;
            }
          })
        );

        for (const data of assetDetails.filter(d => d)) {
          const meta = data.onchain_metadata || {};
          const assetName = meta.name || meta.Asset || Buffer.from(data.asset_name || '', 'hex').toString() || 'Unknown';
          const price = meta.price ? `${(meta.price / 1_000_000).toFixed(2)} ADA` : 'N/A';
  // replace your imageUrl line with this:
let rawImage =
  (Array.isArray(meta.image) ? meta.image[0] : meta.image) ||
  (meta.image && typeof meta.image === 'object' && meta.image.url) ||
  meta.media ||
  (meta.files?.find?.(f => /image\//i.test(f?.mediaType || f?.mimeType))?.src) ||
  (meta.files?.find?.(f => /image\//i.test(f?.mediaType || f?.mimeType))?.url);

const imageUrl = ipfsToHttp(rawImage) || 'https://via.placeholder.com/600x400?text=No+Image';

          const jpgUrl = `https://www.jpg.store/asset/${data.asset}`;

          const embed = new EmbedBuilder()
            .setTitle(`🛒 New Listing Detected`)
            .setDescription(`**${assetName}**\nPrice: ${price}`)
            .setURL(jpgUrl)
            .setImage(imageUrl)
            .setColor(0x00cc99)
            .setFooter({ text: 'Policy Monitor' })
            .setTimestamp();

          try {
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
    await channel.send('✅ Bot is now monitoring listings...');
  } catch (err) {
    console.error('❌ Failed to send startup message:', err.message);
  }
  setInterval(monitorListings, CHECK_INTERVAL);
});

client.login(DISCORD_BOT_TOKEN);
