# Usar imagen de Node.js con Python para yt-dlp
FROM node:18-bullseye

# Instalar dependencias del sistema
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-setuptools \
    python3-wheel \
    ffmpeg \
    curl \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Actualizar pip y instalar yt-dlp
RUN pip3 install --upgrade pip setuptools wheel
RUN pip3 install --upgrade yt-dlp

# Verificar instalación
RUN yt-dlp --version || python3 -m yt_dlp --version

# Crear usuario no-root para seguridad
RUN useradd -m -s /bin/bash appuser

# Crear directorio de trabajo
WORKDIR /app

# Cambiar propietario del directorio
RUN chown -R appuser:appuser /app

# Cambiar a usuario no-root
USER appuser

# Copiar package.json y package-lock.json
COPY --chown=appuser:appuser package*.json ./

# Instalar dependencias de Node.js
RUN npm ci --only=production

# Copiar código fuente
COPY --chown=appuser:appuser . .

# Crear directorio para descargas
RUN mkdir -p /tmp/downloads

# Exponer puerto
EXPOSE 3000

# Comando para iniciar la aplicación
CMD ["node", "server.js"]
