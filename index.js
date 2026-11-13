const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const {
  Client,
  Events,
  GatewayIntentBits,
  ChannelType,
  SlashCommandBuilder,
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
} = require('@discordjs/voice');

const TOKEN = process.env.DISCORD_TOKEN;
const CAROL_DIR = path.join(__dirname, 'carols');
const AUDIO_EXTS = new Set(['.mp3', '.ogg', '.wav', '.flac', '.m4a']);
const CHANNEL_NAME = '🎄 Christmas Carols';
const EMPTY_GRACE_MS = 30_000; // wait this long after everyone leaves before cleaning up

if (!TOKEN) {
  console.error('Set the DISCORD_TOKEN environment variable first.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // enable "Message Content Intent" in the dev portal
  ],
});

// guildId -> { channel, connection, player }
const sessions = new Map();

function loadTracks() {
  if (!fs.existsSync(CAROL_DIR)) return [];
  return fs
    .readdirSync(CAROL_DIR)
    .filter((f) => AUDIO_EXTS.has(path.extname(f).toLowerCase()))
    .sort()
    .map((f) => path.join(CAROL_DIR, f));
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function humansIn(channel) {
  return channel.members.filter((m) => !m.user.bot).size;
}

async function endSession(guildId) {
  const session = sessions.get(guildId);
  if (!session) return;
  sessions.delete(guildId);
  session.player.stop(true);
  try {
    session.connection.destroy();
  } catch {}
  await session.channel.delete('Carol session ended').catch(() => {});
}

async function startSession(guild, member) {
  if (sessions.has(guild.id)) {
    return `Carols are already playing in ${sessions.get(guild.id).channel} 🎶`;
  }

  const tracks = loadTracks();
  if (tracks.length === 0) {
    return 'I have no carols to play. Add audio files to the `carols/` folder and restart me.';
  }

  let channel;
  try {
    channel = await guild.channels.create({
      name: CHANNEL_NAME,
      type: ChannelType.GuildVoice,
      reason: 'Carol session',
    });
  } catch {
    return 'I need the **Manage Channels** permission to create a voice chat.';
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch {
    connection.destroy();
    await channel.delete('Failed to connect').catch(() => {});
    return "I couldn't connect to the new voice chat. Check my **Connect** and **Speak** permissions.";
  }

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play },
  });
  connection.subscribe(player);

  let queue = [];
  const playNext = () => {
    if (queue.length === 0) queue = shuffle(tracks);
    player.play(createAudioResource(queue.shift()));
  };
  player.on(AudioPlayerStatus.Idle, playNext);
  player.on('error', (err) => {
    console.error('Player error:', err.message);
    playNext();
  });

  // If the bot gets kicked or the channel is deleted, clean up.
  connection.on(VoiceConnectionStatus.Destroyed, () => endSession(guild.id));

  sessions.set(guild.id, { channel, connection, player });
  playNext();

  if (member.voice?.channel) {
    await member.voice.setChannel(channel).catch(() => {});
  }

  return `🎄 Created ${channel}. Hop in and enjoy the carols!`;
}

client.once(Events.ClientReady, async (c) => {
  await c.application.commands.set([
    new SlashCommandBuilder()
      .setName('join-voice-chat')
      .setDescription('Create a voice chat and play Christmas carols')
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('stop-carols')
      .setDescription('Stop the carols and remove the voice chat')
      .setDMPermission(false),
  ]);
  console.log(`Logged in as ${c.user.tag} (${loadTracks().length} tracks found)`);
});

// Slash commands: /join-voice-chat and /stop-carols
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.guild) return;

  if (interaction.commandName === 'join-voice-chat') {
    await interaction.deferReply();
    const msg = await startSession(interaction.guild, interaction.member);
    await interaction.editReply(msg);
  } else if (interaction.commandName === 'stop-carols') {
    if (!sessions.has(interaction.guild.id)) {
      await interaction.reply({ content: 'No carols are playing right now.', ephemeral: true });
      return;
    }
    await interaction.reply('Silent night... 🌙 Carols stopped.');
    await endSession(interaction.guild.id);
  }
});

// Text command with spaces: "!join voice chat"
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;
  const text = message.content.trim().toLowerCase();
  if (text === '!join voice chat' || text === 'join voice chat') {
    const msg = await startSession(message.guild, message.member);
    await message.reply(msg);
  }
});

// Clean up when the channel empties out
client.on(Events.VoiceStateUpdate, (oldState) => {
  const guildId = oldState.guild.id;
  const session = sessions.get(guildId);
  if (!session || oldState.channelId !== session.channel.id) return;
  if (humansIn(session.channel) > 0) return;

  setTimeout(() => {
    const current = sessions.get(guildId);
    if (current && humansIn(current.channel) === 0) endSession(guildId);
  }, EMPTY_GRACE_MS);
});

client.login(TOKEN);
