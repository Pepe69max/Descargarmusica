# Usar imagen oficial de Node.js con soporte completo para Python
FROM node:18-bullseye-slim

# Instalar dependencias del sistema necesarias para yt-dlp
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    python3-setuptools \
    python3-wheel \
    ffmpeg \
    curl \
    wget \
    build-essential \
    pipx \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Usar imagen oficial de Node.js con soporte completo para Python
FROM node:18-bullseye-slim

# Instalar dependencias del sistema necesarias para yt-dlp
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    python3-setuptools \
    python3-wheel \
    ffmpeg \
    curl \
    wget \
    build-essential \
    pipx \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Copiar script de instalación
COPY install-ytdlp.sh /tmp/install-ytdlp.sh
RUN chmod +x /tmp/install-ytdlp.sh

# Ejecutar script de instalación
RUN /tmp/install-ytdlp.sh

# Asegurar que el PATH incluya todas las ubicaciones posibles
ENV PATH="/opt/venv/bin:/root/.local/bin:/usr/local/bin:$PATH"
ENV PYTHONPATH="/opt/venv/lib/python3.9/site-packages"

# Crear usuario no-root
RUN useradd -m -s /bin/bash appuser

# Configurar directorio de trabajo
WORKDIR /app
RUN chown -R appuser:appuser /app

# Cambiar a usuario no-root
USER appuser

# Copiar archivos de dependencias
COPY --chown=appuser:appuser package*.json ./

# Instalar dependencias de Node.js
RUN npm ci --only=production && npm cache clean --force

# Copiar el resto del código
COPY --chown=appuser:appuser . .

# Crear directorio temporal para descargas
RUN mkdir -p /tmp/downloads

# Variables de entorno para Python
ENV PYTHONPATH="/opt/venv/lib/python3.9/site-packages"
ENV PATH="/opt/venv/bin:$PATH"

# Exponer puerto
EXPOSE 3000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Comando de inicio
CMD ["node", "server.js"]
