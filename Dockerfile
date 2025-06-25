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
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Crear entorno virtual de Python para evitar conflictos
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Actualizar pip dentro del entorno virtual
RUN pip install --upgrade pip setuptools wheel

# Instalar yt-dlp en el entorno virtual
RUN pip install yt-dlp

# Verificar que yt-dlp funciona correctamente
RUN yt-dlp --version

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
