#!/bin/bash

# Script para instalar yt-dlp en diferentes entornos
# Maneja el error "externally-managed-environment"

echo "🔧 Instalando yt-dlp..."

# Función para verificar si yt-dlp funciona
check_ytdlp() {
    if yt-dlp --version >/dev/null 2>&1; then
        echo "✅ yt-dlp disponible directamente"
        return 0
    elif python3 -m yt_dlp --version >/dev/null 2>&1; then
        echo "✅ yt-dlp disponible via python3 -m"
        return 0
    elif /root/.local/bin/yt-dlp --version >/dev/null 2>&1; then
        echo "✅ yt-dlp disponible via pipx"
        return 0
    else
        return 1
    fi
}

# Verificar si ya está instalado
if check_ytdlp; then
    echo "yt-dlp ya está instalado"
    exit 0
fi

# Método 1: Intentar con pipx (recomendado para externally-managed-environment)
echo "📦 Intentando instalación con pipx..."
if command -v pipx >/dev/null 2>&1; then
    if pipx install yt-dlp; then
        export PATH="/root/.local/bin:$PATH"
        if check_ytdlp; then
            echo "✅ yt-dlp instalado exitosamente con pipx"
            exit 0
        fi
    fi
fi

# Método 2: Crear entorno virtual
echo "📦 Intentando con entorno virtual..."
if python3 -m venv /tmp/ytdlp-env; then
    source /tmp/ytdlp-env/bin/activate
    if pip install yt-dlp; then
        # Crear enlace simbólico
        ln -sf /tmp/ytdlp-env/bin/yt-dlp /usr/local/bin/yt-dlp
        if check_ytdlp; then
            echo "✅ yt-dlp instalado exitosamente con venv"
            exit 0
        fi
    fi
fi

# Método 3: pip con --break-system-packages
echo "📦 Intentando con --break-system-packages..."
if pip3 install --break-system-packages yt-dlp; then
    if check_ytdlp; then
        echo "✅ yt-dlp instalado exitosamente con --break-system-packages"
        exit 0
    fi
fi

# Método 4: Descargar binario directamente
echo "📦 Intentando descarga directa..."
if curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp; then
    chmod +x /usr/local/bin/yt-dlp
    if check_ytdlp; then
        echo "✅ yt-dlp instalado exitosamente via descarga directa"
        exit 0
    fi
fi

echo "❌ No se pudo instalar yt-dlp con ningún método"
exit 1