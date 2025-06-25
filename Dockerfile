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
    && rm -rf /var/lib/apt/lists/*

# Actualizar certificados
RUN update-ca-certificates

# Crear entorno virtual para Python para evitar conflictos
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Actualizar pip en el entorno virtual e instalar yt-dlp
RUN /opt/venv/bin/pip install --upgrade pip setuptools wheel
RUN /opt/venv/bin/pip install --upgrade yt-dlp

# Crear enlace simbólico para facilitar el acceso
RUN ln -sf /opt/venv/bin/yt-dlp /usr/local/bin/yt-dlp

# Verificar instalación
RUN yt-dlp --version && python3 -m yt_dlp --version

# Crear usuario no-root para seguridad
RUN useradd -m -s /bin/bash appuser

# Crear directorio de trabajo
WORKDIR /app

# Cambiar propietario del directorio
RUN chown -R appuser:appuser /app

# Crear directorio para descargas temporales
RUN mkdir -p /tmp/downloads && chown -R appuser:appuser /tmp/downloads

# Cambiar a usuario no-root
USER appuser

# Copiar package.json y package-lock.json
COPY --chown=appuser:appuser package*.json ./

# Instalar dependencias de Node.js
RUN npm ci --only=production

# Copiar código fuente
COPY --chown=appuser:appuser . .

# Variables de entorno para yt-dlp
ENV PYTHONPATH="/opt/venv/lib/python3.9/site-packages"
ENV PATH="/opt/venv/bin:$PATH"

# Exponer puerto
EXPOSE 3000

# Comando de healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Comando para iniciar la aplicación
CMD ["node", "server.js"]
