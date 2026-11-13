import asyncio
import os
import random
from pathlib import Path

import discord
from discord import app_commands
from discord.ext import commands

TOKEN = os.environ["DISCORD_TOKEN"]
CAROL_DIR = Path(__file__).parent / "carols"
AUDIO_EXTS = {".mp3", ".ogg", ".wav", ".flac", ".m4a"}
CHANNEL_NAME = "🎄 Christmas Carols"
EMPTY_GRACE_SECONDS = 30  # how long to wait after everyone leaves before cleaning up

intents = discord.Intents.default()
intents.voice_states = True
intents.message_content = True  # enable "Message Content Intent" in the dev portal


class CarolBot(commands.Bot):
    async def setup_hook(self):
        await self.tree.sync()


bot = CarolBot(command_prefix="!", intents=intents)

# guild_id -> the voice channel the bot created
sessions: dict[int, discord.VoiceChannel] = {}


def load_tracks() -> list[Path]:
    if not CAROL_DIR.is_dir():
        return []
    return [p for p in sorted(CAROL_DIR.iterdir()) if p.suffix.lower() in AUDIO_EXTS]


async def play_loop(guild: discord.Guild, vc: discord.VoiceClient, tracks: list[Path]):
    loop = asyncio.get_running_loop()
    while vc.is_connected() and guild.id in sessions:
        for track in random.sample(tracks, len(tracks)):
            if not vc.is_connected() or guild.id not in sessions:
                return
            finished = asyncio.Event()
            vc.play(
                discord.FFmpegPCMAudio(str(track)),
                after=lambda err: loop.call_soon_threadsafe(finished.set),
            )
            await finished.wait()


async def end_session(guild: discord.Guild):
    channel = sessions.pop(guild.id, None)
    vc = guild.voice_client
    if vc:
        await vc.disconnect(force=True)
    if channel:
        try:
            await channel.delete(reason="Carol session ended")
        except discord.HTTPException:
            pass


async def start_session(guild: discord.Guild, member: discord.Member) -> str:
    if guild.id in sessions:
        return f"Carols are already playing in {sessions[guild.id].mention} 🎶"

    tracks = load_tracks()
    if not tracks:
        return "I have no carols to play. Add audio files to the `carols/` folder and restart me."

    try:
        channel = await guild.create_voice_channel(CHANNEL_NAME, reason="Carol session")
    except discord.Forbidden:
        return "I need the **Manage Channels** permission to create a voice chat."

    try:
        vc = await channel.connect()
    except Exception:
        await channel.delete(reason="Failed to connect")
        return "I couldn't connect to the new voice chat. Check my **Connect** and **Speak** permissions."

    sessions[guild.id] = channel

    if member.voice and member.voice.channel:
        try:
            await member.move_to(channel)
        except discord.HTTPException:
            pass

    asyncio.create_task(play_loop(guild, vc, tracks))
    return f"🎄 Created {channel.mention}. Hop in and enjoy the carols!"


@bot.event
async def on_ready():
    print(f"Logged in as {bot.user} ({len(load_tracks())} tracks found)")


# Slash command: /join-voice-chat
@bot.tree.command(name="join-voice-chat", description="Create a voice chat and play Christmas carols")
@app_commands.guild_only()
async def join_voice_chat(interaction: discord.Interaction):
    await interaction.response.defer()
    msg = await start_session(interaction.guild, interaction.user)
    await interaction.followup.send(msg)


@bot.tree.command(name="stop-carols", description="Stop the carols and remove the voice chat")
@app_commands.guild_only()
async def stop_carols(interaction: discord.Interaction):
    if interaction.guild.id not in sessions:
        await interaction.response.send_message("No carols are playing right now.", ephemeral=True)
        return
    await interaction.response.send_message("Silent night... 🌙 Carols stopped.")
    await end_session(interaction.guild)


# Text command with spaces: "!join voice chat"
@bot.event
async def on_message(message: discord.Message):
    if message.author.bot or not message.guild:
        return
    if message.content.strip().lower() in ("!join voice chat", "join voice chat"):
        msg = await start_session(message.guild, message.author)
        await message.reply(msg)
        return
    await bot.process_commands(message)


# Clean up when the channel empties out
@bot.event
async def on_voice_state_update(member, before, after):
    guild = member.guild
    channel = sessions.get(guild.id)
    if not channel or member.bot:
        return
    if before.channel == channel and not [m for m in channel.members if not m.bot]:
        await asyncio.sleep(EMPTY_GRACE_SECONDS)
        if guild.id in sessions and not [m for m in channel.members if not m.bot]:
            await end_session(guild)


bot.run(TOKEN)
