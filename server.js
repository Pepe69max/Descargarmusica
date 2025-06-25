const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const WebSocket = require('ws');
const http = require('http');

const execAsync = promisify(exec);

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Configuración para Render/Railway
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const PLATFORM = process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || 'development';

// Directorio de descargas - usar /tmp en Railway para archivos temporales
const DOWNLOADS_DIR = NODE_ENV === 'production' 
    ? '/tmp/downloads' 
    : path.join(__dirname, 'downloads');

const MAX_CONCURRENT_DOWNLOADS = 2; // Reducido para Railway
const MAX_FILE_SIZE = '50M'; // Límite de tamaño para Railway
const MAX_DURATION = 3600; // 1 hora máximo

// Middleware
app.use(cors({
    origin: NODE_ENV === 'production' 
        ? process.env.FRONTEND_URL || true
        : '*',
    credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use('/downloads', express.static(DOWNLOADS_DIR));

// Trust proxy para Railway
app.set('trust proxy', 1);

// Health check para Railway
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Estado global
let downloadQueue = [];
let activeDownloads = new Map();
let downloadHistory = [];
let connectedClients = new Set();

// Crear directorio de descargas si no existe
async function ensureDownloadsDir() {
    try {
        await fs.access(DOWNLOADS_DIR);
    } catch {
        await fs.mkdir(DOWNLOADS_DIR, { recursive: true });
        console.log(`📁 Directorio de descargas creado: ${DOWNLOADS_DIR}`);
    }
}

// Limpiar archivos antiguos (importante para Railway)
async function cleanupOldFiles() {
    try {
        const files = await fs.readdir(DOWNLOADS_DIR);
        const now = Date.now();
        const maxAge = 2 * 60 * 60 * 1000; // 2 horas

        for (const file of files) {
            const filePath = path.join(DOWNLOADS_DIR, file);
            const stats = await fs.stat(filePath);
            
            if (now - stats.mtime.getTime() > maxAge) {
                await fs.unlink(filePath);
                console.log(`🗑️ Archivo antiguo eliminado: ${file}`);
            }
        }
    } catch (error) {
        console.error('Error limpiando archivos:', error.message);
    }
}

// WebSocket para actualizaciones en tiempo real
wss.on('connection', (ws) => {
    connectedClients.add(ws);
    console.log('Cliente conectado via WebSocket');
    
    ws.on('close', () => {
        connectedClients.delete(ws);
        console.log('Cliente desconectado');
    });

    ws.on('error', (error) => {
        console.error('Error WebSocket:', error.message);
        connectedClients.delete(ws);
    });
});

// Función para enviar actualizaciones a todos los clientes
function broadcastUpdate(type, data) {
    const message = JSON.stringify({ type, data });
    connectedClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(message);
            } catch (error) {
                console.error('Error enviando mensaje WebSocket:', error.message);
                connectedClients.delete(client);
            }
        }
    });
}

// Verificar si yt-dlp está instalado
// Reemplazar la función checkYtDlp existente con esta versión mejorada:
async function checkYtDlp() {
    try {
        // Primero intentar con yt-dlp directamente
        const { stdout } = await execAsync('yt-dlp --version');
        console.log(`✅ yt-dlp version: ${stdout.trim()}`);
        return 'direct';
    } catch (error) {
        console.log('yt-dlp directo no encontrado, intentando con python3...');
        
        // Intentar con python3 -m yt_dlp
        try {
            const { stdout } = await execAsync('python3 -m yt_dlp --version');
            console.log(`✅ yt-dlp via python3: ${stdout.trim()}`);
            return 'python3';
        } catch (pythonError) {
            console.log('Intentando instalar yt-dlp...');
            
            // Intentar instalar yt-dlp
            try {
                await execAsync('pip3 install --user yt-dlp');
                const { stdout } = await execAsync('python3 -m yt_dlp --version');
                console.log(`✅ yt-dlp instalado y funcionando: ${stdout.trim()}`);
                return 'python3';
            } catch (installError) {
                console.error('❌ No se pudo instalar yt-dlp:', installError.message);
                return false;
            }
        }
    }
}

// Instalar yt-dlp si no está disponible (para Railway/Render)
async function installYtDlp() {
    try {
        console.log('📦 Instalando yt-dlp...');
        
        // Intentar con pip3
        try {
            await execAsync('pip3 install --upgrade yt-dlp');
            console.log('✅ yt-dlp instalado con pip3');
            return true;
        } catch (pipError) {
            console.log('⚠️ pip3 falló, intentando con python3 -m pip');
        }
        
        // Intentar con python3 -m pip
        try {
            await execAsync('python3 -m pip install --upgrade yt-dlp');
            console.log('✅ yt-dlp instalado con python3 -m pip');
            return true;
        } catch (pythonError) {
            console.log('⚠️ python3 -m pip falló, intentando con apt');
        }
        
        // Último intento con apt (Ubuntu/Debian)
        try {
            await execAsync('apt-get update && apt-get install -y python3-pip');
            await execAsync('pip3 install --upgrade yt-dlp');
            console.log('✅ yt-dlp instalado después de actualizar pip');
            return true;
        } catch (aptError) {
            console.error('❌ No se pudo instalar yt-dlp:', aptError.message);
            return false;
        }
        
    } catch (error) {
        console.error('❌ Error instalando yt-dlp:', error.message);
        return false;
    }
}

// Obtener información del video con timeout
async function getVideoInfo(url) {
    try {
        const ytdlpAvailable = await checkYtDlp();
        let command;
        
        switch (ytdlpAvailable) {
            case 'direct':
                command = `timeout 30 yt-dlp --dump-json --no-playlist "${url}"`;
                break;
            case 'python3':
                command = `timeout 30 python3 -m yt_dlp --dump-json --no-playlist "${url}"`;
                break;
            default:
                throw new Error('yt-dlp no está disponible en el servidor. Verifica la instalación.');
        }
        
        console.log(`Ejecutando: ${command}`);
        const { stdout } = await execAsync(command);
        const info = JSON.parse(stdout);
        
        // Validar duración
        if (info.duration && info.duration > MAX_DURATION) {
            throw new Error(`Video demasiado largo. Máximo ${MAX_DURATION/60} minutos permitidos.`);
        }
        
        return {
            title: info.title,
            uploader: info.uploader,
            duration: formatDuration(info.duration),
            view_count: info.view_count,
            thumbnail: info.thumbnail,
            formats: info.formats?.filter(f => f.acodec !== 'none').slice(0, 5) || []
        };
    } catch (error) {
        console.error('Error en getVideoInfo:', error.message);
        throw new Error(`Error obteniendo información del video: ${error.message}`);
    }
}

// Formatear duración
function formatDuration(seconds) {
    if (!seconds) return 'Desconocido';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Descargar video/audio con límites para Railway/Render
async function downloadMedia(url, options, downloadId) {
    return new Promise(async (resolve, reject) => {
        const { quality, format, isPlaylist } = options;
        
        try {
            const ytdlpAvailable = await checkYtDlp();
            let baseCommand = [];
            
            switch (ytdlpAvailable) {
                case 'direct':
                    baseCommand = ['yt-dlp'];
                    break;
                case 'python3':
                    baseCommand = ['python3', '-m', 'yt_dlp'];
                    break;
                default:
                    return reject(new Error('yt-dlp no está disponible en el servidor'));
            }
            
            const command = [
                ...baseCommand,
                '--extract-audio',
                `--audio-format=${format}`,
                `--audio-quality=${quality}`,
                '--output', path.join(DOWNLOADS_DIR, '%(title).100s.%(ext)s'),
                '--no-mtime',
                '--embed-thumbnail',
                '--embed-metadata',
                '--add-metadata',
                `--max-filesize=${MAX_FILE_SIZE}`,
                '--abort-on-error',
                '--no-check-certificate', // Para evitar problemas SSL en algunos entornos
                '--socket-timeout', '30'
            ];

            if (isPlaylist) {
                command.push('--yes-playlist', '--max-downloads=3'); // Reducido para Render
            } else {
                command.push('--no-playlist');
            }

            command.push(url);

            console.log(`Ejecutando descarga: ${command.join(' ')}`);
            
            const process = spawn(command[0], command.slice(1), {
                timeout: 600000, // 10 minutos timeout
                env: { ...process.env, PYTHONPATH: '/opt/venv/lib/python3.9/site-packages' }
            });
            
            let output = '';
            let errorOutput = '';

            process.stdout.on('data', (data) => {
                const text = data.toString();
                output += text;
                console.log('STDOUT:', text);
                
                // Parsear progreso
                const progressMatch = text.match(/\[download\]\s+(\d+\.?\d*)%/);
                if (progressMatch) {
                    const progress = parseFloat(progressMatch[1]);
                    broadcastUpdate('progress', {
                        downloadId,
                        progress,
                        status: 'downloading'
                    });
                }
            });

            process.stderr.on('data', (data) => {
                const text = data.toString();
                errorOutput += text;
                console.error('STDERR:', text);
            });

            process.on('close', (code) => {
                console.log(`Proceso terminado con código: ${code}`);
                if (code === 0) {
                    broadcastUpdate('progress', {
                        downloadId,
                        progress: 100,
                        status: 'completed'
                    });
                    resolve({ success: true, output });
                } else {
                    reject(new Error(`yt-dlp falló con código ${code}: ${errorOutput}`));
                }
            });

            process.on('error', (error) => {
                console.error('Error del proceso:', error);
                reject(new Error(`Error ejecutando yt-dlp: ${error.message}`));
            });

            // Guardar referencia del proceso
            activeDownloads.set(downloadId, process);
            
        } catch (error) {
            reject(new Error(`Error configurando descarga: ${error.message}`));
        }
    });
}

// Rutas de la API

// Verificar estado del servidor
app.get('/api/status', async (req, res) => {
    const ytDlpAvailable = await checkYtDlp();
    res.json({
        status: 'ok',
        environment: NODE_ENV,
        platform: PLATFORM,
        ytDlpAvailable,
        activeDownloads: activeDownloads.size,
        queueLength: downloadQueue.length,
        downloadsDir: DOWNLOADS_DIR
    });
});

// Obtener información del video
app.post('/api/video-info', async (req, res) => {
    try {
        const { url } = req.body;
        
        if (!url) {
            return res.status(400).json({ error: 'URL es requerida' });
        }

        // Validar URL básica
        if (!url.match(/^https?:\/\//)) {
            return res.status(400).json({ error: 'URL inválida' });
        }

        const info = await getVideoInfo(url);
        res.json(info);
    } catch (error) {
        console.error('Error obteniendo info:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Agregar descarga a la cola
app.post('/api/download', async (req, res) => {
    try {
        const { url, quality = '192', format = 'mp3', isPlaylist = false } = req.body;
        
        if (!url) {
            return res.status(400).json({ error: 'URL es requerida' });
        }

        // Limitar cola para Railway
        if (downloadQueue.length >= 10) {
            return res.status(429).json({ error: 'Cola llena. Intenta más tarde.' });
        }

        const downloadId = `download_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        const downloadItem = {
            id: downloadId,
            url,
            quality,
            format,
            isPlaylist,
            status: 'queued',
            addedAt: new Date().toISOString()
        };

        downloadQueue.push(downloadItem);
        
        // Procesar cola si hay capacidad
        processQueue();
        
        res.json({ 
            success: true, 
            downloadId,
            position: downloadQueue.length 
        });
    } catch (error) {
        console.error('Error agregando descarga:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Obtener estado de la cola
app.get('/api/queue', (req, res) => {
    res.json({
        queue: downloadQueue,
        active: Array.from(activeDownloads.keys()),
        history: downloadHistory.slice(-20)
    });
});

// Cancelar descarga
app.delete('/api/download/:downloadId', (req, res) => {
    const { downloadId } = req.params;
    
    try {
        // Cancelar descarga activa
        if (activeDownloads.has(downloadId)) {
            const process = activeDownloads.get(downloadId);
            process.kill('SIGTERM');
            activeDownloads.delete(downloadId);
            
            broadcastUpdate('cancelled', { downloadId });
        }
        
        // Remover de la cola
        downloadQueue = downloadQueue.filter(item => item.id !== downloadId);
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error cancelando descarga:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Limpiar cola
app.delete('/api/queue', (req, res) => {
    try {
        // Solo permitir si no hay descargas activas
        if (activeDownloads.size > 0) {
            return res.status(400).json({ error: 'No se puede limpiar la cola con descargas activas' });
        }
        
        downloadQueue = [];
        res.json({ success: true });
    } catch (error) {
        console.error('Error limpiando cola:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Listar archivos descargados
app.get('/api/downloads', async (req, res) => {
    try {
        const files = await fs.readdir(DOWNLOADS_DIR);
        const fileDetails = await Promise.all(
            files.map(async (file) => {
                try {
                    const filePath = path.join(DOWNLOADS_DIR, file);
                    const stats = await fs.stat(filePath);
                    return {
                        name: file,
                        size: stats.size,
                        created: stats.birthtime,
                        downloadUrl: `/downloads/${encodeURIComponent(file)}`
                    };
                } catch (error) {
                    return null;
                }
            })
        );
        
        const validFiles = fileDetails.filter(f => f !== null);
        res.json(validFiles.sort((a, b) => b.created - a.created));
    } catch (error) {
        console.error('Error listando archivos:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Descargar archivo
app.get('/api/download-file/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(DOWNLOADS_DIR, filename);
    
    res.download(filePath, (err) => {
        if (err) {
            console.error('Error descargando archivo:', err.message);
            res.status(404).json({ error: 'Archivo no encontrado' });
        }
    });
});

// Eliminar archivo descargado
app.delete('/api/file/:filename', async (req, res) => {
    try {
        const filename = req.params.filename;
        const filePath = path.join(DOWNLOADS_DIR, filename);
        await fs.unlink(filePath);
        res.json({ success: true });
    } catch (error) {
        console.error('Error eliminando archivo:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Procesar cola de descargas
async function processQueue() {
    // Verificar si podemos procesar más descargas
    if (activeDownloads.size >= MAX_CONCURRENT_DOWNLOADS) {
        return;
    }
    
    // Buscar siguiente item en cola
    const nextItem = downloadQueue.find(item => item.status === 'queued');
    if (!nextItem) {
        return;
    }
    
    // Marcar como procesando
    nextItem.status = 'downloading';
    nextItem.startedAt = new Date().toISOString();
    
    broadcastUpdate('started', { downloadId: nextItem.id });
    
    try {
        await downloadMedia(nextItem.url, {
            quality: nextItem.quality,
            format: nextItem.format,
            isPlaylist: nextItem.isPlaylist
        }, nextItem.id);
        
        // Mover a historial
        nextItem.status = 'completed';
        nextItem.completedAt = new Date().toISOString();
        downloadHistory.push(nextItem);
        
        // Remover de cola
        downloadQueue = downloadQueue.filter(item => item.id !== nextItem.id);
        
        broadcastUpdate('completed', { downloadId: nextItem.id });
        
    } catch (error) {
        nextItem.status = 'failed';
        nextItem.error = error.message;
        nextItem.failedAt = new Date().toISOString();
        
        broadcastUpdate('failed', { 
            downloadId: nextItem.id, 
            error: error.message 
        });
        
        console.error(`Error en descarga ${nextItem.id}:`, error.message);
    } finally {
        activeDownloads.delete(nextItem.id);
        
        // Continuar procesando cola
        setTimeout(processQueue, 1000);
    }
}

// Servir frontend estático
if (NODE_ENV === 'production') {
    app.use(express.static(path.join(__dirname, 'public')));
    
    // Ruta catch-all para SPA
    app.get('*', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });
}

// Iniciar servidor
async function startServer() {
    try {
        await ensureDownloadsDir();
        
        let ytDlpAvailable = await checkYtDlp();
        
        // Intentar instalar yt-dlp si no está disponible
        if (!ytDlpAvailable && NODE_ENV === 'production') {
            ytDlpAvailable = await installYtDlp();
        }
        
        if (!ytDlpAvailable) {
            console.warn('⚠️  yt-dlp no está disponible. Instálalo para funcionalidad completa.');
        }
        
        // Limpiar archivos antiguos cada 30 minutos
        setInterval(cleanupOldFiles, 30 * 60 * 1000);
        
        server.listen(PORT, '0.0.0.0', () => {
            console.log(`🚀 Servidor iniciado en puerto ${PORT}`);
            console.log(`🌍 Entorno: ${NODE_ENV}`);
            console.log(`🔧 Plataforma: ${PLATFORM}`);
            console.log(`📁 Directorio de descargas: ${DOWNLOADS_DIR}`);
            console.log(`🎵 yt-dlp disponible: ${ytDlpAvailable ? '✅' : '❌'}`);
        });
        
    } catch (error) {
        console.error('❌ Error iniciando servidor:', error);
        process.exit(1);
    }
}

// Manejo de errores no capturados
process.on('uncaughtException', (error) => {
    console.error('Error no capturado:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Promesa rechazada no manejada:', reason);
});

// Limpieza al cerrar
process.on('SIGTERM', () => {
    console.log('\n🛑 Cerrando servidor (SIGTERM)...');
    gracefulShutdown();
});

process.on('SIGINT', () => {
    console.log('\n🛑 Cerrando servidor (SIGINT)...');
    gracefulShutdown();
});

function gracefulShutdown() {
    // Cancelar descargas activas
    activeDownloads.forEach((process, id) => {
        console.log(`Cancelando descarga ${id}`);
        try {
            process.kill('SIGTERM');
        } catch (error) {
            console.error(`Error cancelando descarga ${id}:`, error.message);
        }
    });
    
    server.close(() => {
        console.log('✅ Servidor cerrado correctamente');
        process.exit(0);
    });
    
    // Forzar cierre después de 10 segundos
    setTimeout(() => {
        console.log('🔴 Forzando cierre del servidor');
        process.exit(1);
    }, 10000);
}

startServer().catch(console.error);
