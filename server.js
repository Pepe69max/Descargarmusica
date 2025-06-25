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

const COOKIES_DIR = NODE_ENV === 'production'
    ? '/tmp/cookies'
    : path.join(__dirname, 'cookies');

const MAX_CONCURRENT_DOWNLOADS = 1; // Reducido a 1 para evitar rate limiting
const MAX_FILE_SIZE = '50M';
const MAX_DURATION = 3600;

// Configuración para evitar rate limiting
const RATE_LIMIT_DELAY = 10000; // 10 segundos entre descargas
let lastDownloadTime = 0;

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

// Health check
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Estado global
let downloadQueue = [];
let activeDownloads = new Map();
let downloadHistory = [];
let connectedClients = new Set();

// Crear directorios necesarios
async function ensureDirectories() {
    try {
        await fs.access(DOWNLOADS_DIR);
    } catch {
        await fs.mkdir(DOWNLOADS_DIR, { recursive: true });
        console.log(`📁 Directorio de descargas creado: ${DOWNLOADS_DIR}`);
    }
    
    try {
        await fs.access(COOKIES_DIR);
    } catch {
        await fs.mkdir(COOKIES_DIR, { recursive: true });
        console.log(`🍪 Directorio de cookies creado: ${COOKIES_DIR}`);
    }
}

// Crear archivo de cookies básico para evitar detección de bot
async function setupCookies() {
    const cookiesFile = path.join(COOKIES_DIR, 'youtube.txt');
    
    try {
        await fs.access(cookiesFile);
        console.log('✅ Archivo de cookies encontrado');
        return cookiesFile;
    } catch {
        // Crear un archivo de cookies básico (vacío pero válido)
        const basicCookies = `# Netscape HTTP Cookie File
# This is a generated file! Do not edit.

`;
        await fs.writeFile(cookiesFile, basicCookies);
        console.log('🍪 Archivo de cookies básico creado');
        return cookiesFile;
    }
}

// Limpiar archivos antiguos
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

// WebSocket para actualizaciones
wss.on('connection', (ws) => {
    connectedClients.add(ws);
    console.log('Cliente conectado via WebSocket');
    
    ws.on('close', () => {
        connectedClients.delete(ws);
    });

    ws.on('error', (error) => {
        console.error('Error WebSocket:', error.message);
        connectedClients.delete(ws);
    });
});

function broadcastUpdate(type, data) {
    const message = JSON.stringify({ type, data });
    connectedClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(message);
            } catch (error) {
                connectedClients.delete(client);
            }
        }
    });
}

// Verificar yt-dlp con mejores headers
async function checkYtDlp() {
    const possiblePaths = [
        'yt-dlp',
        '/usr/local/bin/yt-dlp',
        '/root/.local/bin/yt-dlp',
        '/opt/venv/bin/yt-dlp'
    ];
    
    for (const path of possiblePaths) {
        try {
            const { stdout } = await execAsync(`${path} --version`);
            console.log(`✅ yt-dlp encontrado en ${path}: ${stdout.trim()}`);
            return 'direct';
        } catch (error) {
            continue;
        }
    }
    
    try {
        const { stdout } = await execAsync('python3 -m yt_dlp --version');
        console.log(`✅ yt-dlp via python3: ${stdout.trim()}`);
        return 'python3';
    } catch (error) {
        console.log('yt-dlp no encontrado, intentando instalar...');
        return await installYtDlp();
    }
}

async function installYtDlp() {
    const installMethods = [
        // Método 1: pip con usuario
        async () => {
            await execAsync('pip3 install --user --upgrade yt-dlp');
            process.env.PATH = `/root/.local/bin:${process.env.PATH}`;
        },
        // Método 2: pip con break-system-packages
        async () => {
            await execAsync('pip3 install --break-system-packages --upgrade yt-dlp');
        },
        // Método 3: python -m pip
        async () => {
            await execAsync('python3 -m pip install --user --upgrade yt-dlp');
        }
    ];
    
    for (let i = 0; i < installMethods.length; i++) {
        try {
            console.log(`Intentando método de instalación ${i + 1}...`);
            await installMethods[i]();
            
            // Verificar instalación
            try {
                await execAsync('yt-dlp --version');
                console.log('✅ yt-dlp instalado exitosamente');
                return 'direct';
            } catch {
                try {
                    await execAsync('python3 -m yt_dlp --version');
                    console.log('✅ yt-dlp via python3 instalado');
                    return 'python3';
                } catch {
                    continue;
                }
            }
        } catch (error) {
            console.log(`Método ${i + 1} falló: ${error.message}`);
        }
    }
    
    console.error('❌ No se pudo instalar yt-dlp');
    return false;
}

// Rate limiting para evitar 429
async function waitForRateLimit() {
    const now = Date.now();
    const timeSinceLastDownload = now - lastDownloadTime;
    
    if (timeSinceLastDownload < RATE_LIMIT_DELAY) {
        const waitTime = RATE_LIMIT_DELAY - timeSinceLastDownload;
        console.log(`⏱️ Esperando ${waitTime/1000}s para evitar rate limiting...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    lastDownloadTime = Date.now();
}

// Obtener información del video con headers mejorados
async function getVideoInfo(url) {
    try {
        const ytdlpAvailable = await checkYtDlp();
        const cookiesFile = await setupCookies();
        
        let command;
        const baseArgs = [
            '--dump-json',
            '--no-playlist',
            '--user-agent', '"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"',
            '--referer', '"https://www.youtube.com/"',
            '--cookies', cookiesFile,
            '--extractor-retries', '3',
            '--fragment-retries', '3',
            '--retry-sleep', '5',
            '--ignore-errors'
        ];
        
        switch (ytdlpAvailable) {
            case 'direct':
                command = `timeout 45 yt-dlp ${baseArgs.join(' ')} "${url}"`;
                break;
            case 'python3':
                command = `timeout 45 python3 -m yt_dlp ${baseArgs.join(' ')} "${url}"`;
                break;
            default:
                throw new Error('yt-dlp no está disponible en el servidor');
        }
        
        console.log(`Obteniendo info: ${command}`);
        const { stdout } = await execAsync(command);
        const info = JSON.parse(stdout);
        
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
        throw new Error(`Error obteniendo información: ${error.message}`);
    }
}

function formatDuration(seconds) {
    if (!seconds) return 'Desconocido';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Descargar con configuración anti-rate-limiting
async function downloadMedia(url, options, downloadId) {
    return new Promise(async (resolve, reject) => {
        const { quality, format, isPlaylist } = options;
        
        try {
            // Esperar para evitar rate limiting
            await waitForRateLimit();
            
            const ytdlpAvailable = await checkYtDlp();
            const cookiesFile = await setupCookies();
            
            let baseCommand = [];
            
            switch (ytdlpAvailable) {
                case 'direct':
                    baseCommand = ['yt-dlp'];
                    break;
                case 'python3':
                    baseCommand = ['python3', '-m', 'yt_dlp'];
                    break;
                default:
                    return reject(new Error('yt-dlp no está disponible'));
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
                '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                '--referer', 'https://www.youtube.com/',
                '--cookies', cookiesFile,
                '--extractor-retries', '5',
                '--fragment-retries', '5',
                '--retry-sleep', '10',
                '--sleep-interval', '5',
                '--max-sleep-interval', '15',
                '--ignore-errors',
                '--no-check-certificate',
                '--socket-timeout', '60'
            ];

            if (isPlaylist) {
                command.push('--yes-playlist', '--max-downloads=2');
            } else {
                command.push('--no-playlist');
            }

            command.push(url);

            console.log(`🎵 Iniciando descarga: ${command.join(' ')}`);
            
            const childProcess = spawn(command[0], command.slice(1), {
                timeout: 900000, // 15 minutos
                env: { 
                    ...process.env, 
                    PYTHONPATH: '/opt/venv/lib/python3.9/site-packages',
                    PYTHONIOENCODING: 'utf-8'
                }
            });
            
            let output = '';
            let errorOutput = '';

            childProcess.stdout.on('data', (data) => {
                const text = data.toString();
                output += text;
                console.log('STDOUT:', text);
                
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

            childProcess.stderr.on('data', (data) => {
                const text = data.toString();
                errorOutput += text;
                console.error('STDERR:', text);
            });

            childProcess.on('close', (code) => {
                console.log(`Proceso terminado con código: ${code}`);
                if (code === 0) {
                    broadcastUpdate('progress', {
                        downloadId,
                        progress: 100,
                        status: 'completed'
                    });
                    resolve({ success: true, output });
                } else {
                    let errorMessage = `yt-dlp falló con código ${code}`;
                    
                    // Mensajes de error más específicos
                    if (errorOutput.includes('429')) {
                        errorMessage = 'Rate limit alcanzado. Intenta de nuevo en unos minutos.';
                    } else if (errorOutput.includes('Sign in to confirm')) {
                        errorMessage = 'YouTube requiere verificación. Intenta con otro video.';
                    } else if (errorOutput.includes('Video unavailable')) {
                        errorMessage = 'Video no disponible o privado.';
                    }
                    
                    reject(new Error(errorMessage));
                }
            });

            childProcess.on('error', (error) => {
                console.error('Error del proceso:', error);
                reject(new Error(`Error ejecutando yt-dlp: ${error.message}`));
            });

            activeDownloads.set(downloadId, childProcess);
            
        } catch (error) {
            reject(new Error(`Error configurando descarga: ${error.message}`));
        }
    });
}

// Rutas API mejoradas
app.get('/api/status', async (req, res) => {
    const ytDlpAvailable = await checkYtDlp();
    res.json({
        status: 'ok',
        environment: NODE_ENV,
        platform: PLATFORM,
        ytDlpAvailable,
        activeDownloads: activeDownloads.size,
        queueLength: downloadQueue.length,
        downloadsDir: DOWNLOADS_DIR,
        rateLimitStatus: {
            lastDownload: lastDownloadTime,
            nextAvailable: Math.max(0, (lastDownloadTime + RATE_LIMIT_DELAY) - Date.now())
        }
    });
});

app.post('/api/video-info', async (req, res) => {
    try {
        const { url } = req.body;
        
        if (!url || !url.match(/^https?:\/\//)) {
            return res.status(400).json({ error: 'URL inválida' });
        }

        const info = await getVideoInfo(url);
        res.json(info);
    } catch (error) {
        console.error('Error obteniendo info:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/download', async (req, res) => {
    try {
        const { url, quality = '192', format = 'mp3', isPlaylist = false } = req.body;
        
        if (!url) {
            return res.status(400).json({ error: 'URL es requerida' });
        }

        if (downloadQueue.length >= 5) { // Reducido para evitar rate limiting
            return res.status(429).json({ error: 'Cola llena. Máximo 5 descargas en cola.' });
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
        processQueue();
        
        res.json({ 
            success: true, 
            downloadId,
            position: downloadQueue.length,
            estimatedWait: downloadQueue.length * (RATE_LIMIT_DELAY / 1000)
        });
    } catch (error) {
        console.error('Error agregando descarga:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/queue', (req, res) => {
    res.json({
        queue: downloadQueue,
        active: Array.from(activeDownloads.keys()),
        history: downloadHistory.slice(-20),
        rateLimitInfo: {
            delayBetweenDownloads: RATE_LIMIT_DELAY / 1000,
            lastDownload: lastDownloadTime,
            nextAvailable: Math.max(0, (lastDownloadTime + RATE_LIMIT_DELAY) - Date.now())
        }
    });
});

app.delete('/api/download/:downloadId', (req, res) => {
    const { downloadId } = req.params;
    
    try {
        if (activeDownloads.has(downloadId)) {
            const process = activeDownloads.get(downloadId);
            process.kill('SIGTERM');
            activeDownloads.delete(downloadId);
            broadcastUpdate('cancelled', { downloadId });
        }
        
        downloadQueue = downloadQueue.filter(item => item.id !== downloadId);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

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
        res.status(500).json({ error: error.message });
    }
});

// Procesar cola con rate limiting
async function processQueue() {
    if (activeDownloads.size >= MAX_CONCURRENT_DOWNLOADS) {
        return;
    }
    
    const nextItem = downloadQueue.find(item => item.status === 'queued');
    if (!nextItem) {
        return;
    }
    
    nextItem.status = 'downloading';
    nextItem.startedAt = new Date().toISOString();
    
    broadcastUpdate('started', { downloadId: nextItem.id });
    
    try {
        await downloadMedia(nextItem.url, {
            quality: nextItem.quality,
            format: nextItem.format,
            isPlaylist: nextItem.isPlaylist
        }, nextItem.id);
        
        nextItem.status = 'completed';
        nextItem.completedAt = new Date().toISOString();
        downloadHistory.push(nextItem);
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
        
        // Esperar antes de procesar siguiente
        setTimeout(processQueue, 2000);
    }
}

// Servir frontend
if (NODE_ENV === 'production') {
    app.use(express.static(path.join(__dirname, 'public')));
    app.get('*', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });
}

// Graceful shutdown
function gracefulShutdown() {
    activeDownloads.forEach((process, id) => {
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
    
    setTimeout(() => {
        process.exit(1);
    }, 10000);
}

async function startServer() {
    try {
        await ensureDirectories();
        await setupCookies();
        
        let ytDlpAvailable = await checkYtDlp();
        
        if (!ytDlpAvailable) {
            console.warn('⚠️ yt-dlp no disponible');
        }
        
        setInterval(cleanupOldFiles, 30 * 60 * 1000);
        
        server.listen(PORT, '0.0.0.0', () => {
            console.log(`🚀 Servidor iniciado en puerto ${PORT}`);
            console.log(`🌍 Entorno: ${NODE_ENV}`);
            console.log(`🔧 Rate limiting: ${RATE_LIMIT_DELAY/1000}s entre descargas`);
            console.log(`🎵 yt-dlp: ${ytDlpAvailable ? '✅' : '❌'}`);
        });
        
    } catch (error) {
        console.error('❌ Error iniciando servidor:', error);
        process.exit(1);
    }
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

startServer().catch(console.error);
