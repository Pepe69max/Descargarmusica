# Usar imagen de Node.js con Python para yt-dlp
FROM node:18-bullseye

# Instalar dependencias del sistema
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-setuptools \
    python3-wheel \
    python3-venv \
    ffmpeg \
    curl \
    wget \
    ca-certificates \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Actualizar certificados
RUN update-ca-certificates

# Crear entorno virtual para Python
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Actualizar pip e instalar yt-dlp con versión específica
RUN /opt/venv/bin/pip install --upgrade pip setuptools wheel
RUN /opt/venv/bin/pip install --upgrade yt-dlp>=2023.12.30

# Crear enlace simbólico
RUN ln -sf /opt/venv/bin/yt-dlp /usr/local/bin/yt-dlp

# Verificar instalación
RUN yt-dlp --version

# Crear usuario no-root
RUN useradd -m -s /bin/bash appuser

# Crear directorios de trabajo
WORKDIR /app
RUN mkdir -p /tmp/downloads /tmp/cookies
RUN chown -R appuser:appuser /app /tmp/downloads /tmp/cookies

# Configurar archivo de cookies básico
RUN echo "# Netscape HTTP Cookie File" > /tmp/cookies/youtube.txt && \
    echo "# This is a generated file! Do not edit." >> /tmp/cookies/youtube.txt && \
    echo "" >> /tmp/cookies/youtube.txt && \
    chown appuser:appuser /tmp/cookies/youtube.txt

# Cambiar a usuario no-root
USER appuser

# Copiar archivos de configuración
COPY --chown=appuser:appuser package*.json ./

# Instalar dependencias de Node.js
RUN npm ci --only=production

# Copiar código fuente
COPY --chown=appuser:appuser . .

# Variables de entorno mejoradas
ENV PYTHONPATH="/opt/venv/lib/python3.9/site-packages"
ENV PATH="/opt/venv/bin:$PATH"
ENV PYTHONIOENCODING=utf-8
ENV PYTHONUNBUFFERED=1

# Exponer puerto
EXPOSE 3000

# Healthcheck mejorado
HEALTHCHECK --interval=30s --timeout=15s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Comando para iniciar la aplicación
CMD ["node", "server.js"]
