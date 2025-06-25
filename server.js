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

// Configuración
const PORT = process.env.PORT || 3001;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const MAX_CONCURRENT_DOWNLOADS = 3;

// Middleware
app.use(cors());
app.use(express.json());
app.use('/downloads', express.static(DOWNLOADS_DIR));

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
});

// Función para enviar actualizaciones a todos los clientes
function broadcastUpdate(type, data) {
    const message = JSON.stringify({ type, data });
    connectedClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// Verificar si yt-dlp está instalado
async function checkYtDlp() {
    try {
        await execAsync('yt-dlp --version');
        return true;
    } catch (error) {
        console.error('yt-dlp no está instalado o no está en el PATH');
        return false;
    }
}

// Obtener información del video
async function getVideoInfo(url) {
    try {
        const command = `yt-dlp --dump-json --no-playlist "${url}"`;
        const { stdout } = await execAsync(command);
        const info = JSON.parse(stdout);
        
        return {
            title: info.title,
            uploader: info.uploader,
            duration: formatDuration(info.duration),
            view_count: info.view_count,
            thumbnail: info.thumbnail,
            formats: info.formats?.filter(f => f.acodec !== 'none').slice(0, 5) || []
        };
    } catch (error) {
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

// Descargar video/audio
async function downloadMedia(url, options, downloadId) {
    return new Promise((resolve, reject) => {
        const { quality, format, isPlaylist } = options;
        
        // Construir comando yt-dlp
        let command = [
            'yt-dlp',
            '--extract-audio',
            `--audio-format=${format}`,
            `--audio-quality=${quality}`,
            '--output', path.join(DOWNLOADS_DIR, '%(title)s.%(ext)s'),
            '--no-mtime',
            '--embed-metadata',
            '--add-metadata'
        ];

        if (isPlaylist) {
            command.push('--yes-playlist');
        } else {
            command.push('--no-playlist');
        }

        command.push(url);

        const process = spawn(command[0], command.slice(1));
        let output = '';
        let errorOutput = '';

        process.stdout.on('data', (data) => {
            const text = data.toString();
            output += text;
            
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
            errorOutput += data.toString();
        });

        process.on('close', (code) => {
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

        // Guardar referencia del proceso para poder cancelarlo
        activeDownloads.set(downloadId, process);
    });
}

// Rutas de la API

// Verificar estado del servidor
app.get('/api/status', async (req, res) => {
    const ytDlpAvailable = await checkYtDlp();
    res.json({
        status: 'ok',
        ytDlpAvailable,
        activeDownloads: activeDownloads.size,
        queueLength: downloadQueue.length
    });
});

// Obtener información del video
app.post('/api/video-info', async (req, res) => {
    try {
        const { url } = req.body;
        
        if (!url) {
            return res.status(400).json({ error: 'URL es requerida' });
        }

        const info = await getVideoInfo(url);
        res.json(info);
    } catch (error) {
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
        res.status(500).json({ error: error.message });
    }
});

// Obtener estado de la cola
app.get('/api/queue', (req, res) => {
    res.json({
        queue: downloadQueue,
        active: Array.from(activeDownloads.keys()),
        history: downloadHistory.slice(-20) // Últimas 20 descargas
    });
});

// Cancelar descarga
app.delete('/api/download/:downloadId', (req, res) => {
    const { downloadId } = req.params;
    
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
});

// Limpiar cola
app.delete('/api/queue', (req, res) => {
    // Solo permitir si no hay descargas activas
    if (activeDownloads.size > 0) {
        return res.status(400).json({ error: 'No se puede limpiar la cola con descargas activas' });
    }
    
    downloadQueue = [];
    res.json({ success: true });
});

// Listar archivos descargados
app.get('/api/downloads', async (req, res) => {
    try {
        const files = await fs.readdir(DOWNLOADS_DIR);
        const fileDetails = await Promise.all(
            files.map(async (file) => {
                const filePath = path.join(DOWNLOADS_DIR, file);
                const stats = await fs.stat(filePath);
                return {
                    name: file,
                    size: stats.size,
                    created: stats.birthtime,
                    downloadUrl: `/downloads/${encodeURIComponent(file)}`
                };
            })
        );
        
        res.json(fileDetails.sort((a, b) => b.created - a.created));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Descargar archivo
app.get('/api/download-file/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(DOWNLOADS_DIR, filename);
    
    res.download(filePath, (err) => {
        if (err) {
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
app.use(express.static(path.join(__dirname, 'public')));

// Ruta catch-all para SPA
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Iniciar servidor
async function startServer() {
    await ensureDownloadsDir();
    
    const ytDlpAvailable = await checkYtDlp();
    if (!ytDlpAvailable) {
        console.warn('⚠️  yt-dlp no está disponible. Instálalo para funcionalidad completa.');
    }
    
    server.listen(PORT, () => {
        console.log(`🚀 Servidor iniciado en puerto ${PORT}`);
        console.log(`📁 Directorio de descargas: ${DOWNLOADS_DIR}`);
        console.log(`🎵 yt-dlp disponible: ${ytDlpAvailable ? '✅' : '❌'}`);
    });
}

// Manejo de errores no capturados
process.on('uncaughtException', (error) => {
    console.error('Error no capturado:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Promesa rechazada no manejada:', reason);
});

// Limpieza al cerrar
process.on('SIGINT', () => {
    console.log('\n🛑 Cerrando servidor...');
    
    // Cancelar descargas activas
    activeDownloads.forEach((process, id) => {
        console.log(`Cancelando descarga ${id}`);
        process.kill('SIGTERM');
    });
    
    server.close(() => {
        console.log('✅ Servidor cerrado correctamente');
        process.exit(0);
    });
});

startServer().catch(console.error);
// Servir el frontend desde la carpeta public
app.use(express.static(path.join(__dirname, 'public')));