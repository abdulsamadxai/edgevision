FROM python:3.11-slim

# Install FFmpeg, FFprobe, and required OpenCV libraries
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source
COPY . .

# Ensure storage directories exist
RUN mkdir -p storage/uploads storage/outputs storage/previews

ENV PORT=8000
EXPOSE 8000

# Start server using $PORT for compatibility with Render, Railway, Fly.io, etc.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
