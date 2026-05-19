FROM node:20-slim

# Install system dependencies for audio (ffmpeg, python for gtts, opus)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    build-essential \
    libtool \
    autoconf \
    automake \
    libopus-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./

# Install node dependencies
RUN npm install --omit=dev

# Copy source
COPY . .

# Create /tmp for TTS audio files
RUN mkdir -p /tmp

CMD ["node", "bot.js"]
