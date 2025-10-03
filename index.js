    const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const { google } = require('googleapis');
const axios = require('axios');
const cors = require('cors');
const multer = require('multer');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '2gb' }));

// Configuração do multer para upload de arquivos
const upload = multer({ dest: path.join(__dirname, 'uploads') });

// Pasta temporária
const tempFolder = path.join(__dirname, 'videos');
if (!fs.existsSync(tempFolder)) fs.mkdirSync(tempFolder);

// --- Função para extrair FILE_ID do link do Drive ---
function extractDriveFileId(url) {
  const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

// --- Servir HTML ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// --- Rota upload/render ---
app.post(
  '/upload',
  upload.fields([
    { name: 'thumbnail', maxCount: 1 },
    { name: 'credentials', maxCount: 1 }
  ]),
  async (req, res) => {
    const tempFiles = [];

    try {
      const { title, description, publishAt, videoUrl } = req.body;

      if (!title || !description || !publishAt || !videoUrl) {
        return res.status(400).json({ success: false, message: 'Todos os campos de texto são obrigatórios' });
      }

      // --- Credenciais ---
      if (!req.files['credentials']) {
        return res.status(400).json({ success: false, message: 'Arquivo de credenciais é obrigatório' });
      }
      const credPath = req.files['credentials'][0].path;
      tempFiles.push(credPath);
      const creds = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
      const { client_id, client_secret, refresh_token } = creds;

      // --- Baixar vídeo do Google Drive ---
      const fileId = extractDriveFileId(videoUrl);
      if (!fileId) return res.status(400).json({ success: false, message: 'URL do Drive inválida' });

      const downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
      const videoPath = path.join(tempFolder, `video_${Date.now()}.mp4`);
      tempFiles.push(videoPath);

      console.log("⬇️ Baixando vídeo do Google Drive...");
      const videoResponse = await axios.get(downloadUrl, { responseType: 'stream' });
      const writer = fs.createWriteStream(videoPath);
      videoResponse.data.pipe(writer);
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
      console.log("✅ Vídeo baixado:", videoPath);

      // --- Processar vídeo de miniatura ---
      if (!req.files['thumbnail']) {
        return res.status(400).json({ success: false, message: 'Vídeo de miniatura é obrigatório' });
      }
      let thumbPath = req.files['thumbnail'][0].path;
      tempFiles.push(thumbPath);

      // Redimensionar miniatura se não tiver proporção 1080x1920
      const resizedThumb = path.join(tempFolder, `thumb_${Date.now()}.mp4`);
      tempFiles.push(resizedThumb);

      console.log("🖼️ Ajustando proporção do vídeo de miniatura...");
      await new Promise((resolve, reject) => {
        ffmpeg(thumbPath)
          .size('1080x1920')
          .outputOptions('-c:v libx264', '-pix_fmt yuv420p', '-r 30')
          .on('start', cmd => console.log('FFmpeg thumb resize command:', cmd))
          .on('progress', progress => console.log(`Progresso miniatura: ${progress.percent ? progress.percent.toFixed(2) : 0}%`))
          .on('end', resolve)
          .on('error', reject)
          .save(resizedThumb);
      });
      console.log("✅ Miniatura ajustada:", resizedThumb);

      // --- Concatenar miniatura + vídeo principal ---
      const finalVideoPath = path.join(tempFolder, `final_${Date.now()}.mp4`);
      const concatFile = path.join(tempFolder, `inputs_${Date.now()}.txt`);
      tempFiles.push(finalVideoPath, concatFile);

      fs.writeFileSync(concatFile, `file '${resizedThumb}'\nfile '${videoPath}'\n`);
      console.log("🎬 Concatenando miniatura e vídeo principal...");

      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(concatFile)
          .inputOptions('-f concat', '-safe 0')
          .outputOptions('-c copy')
          .on('start', cmd => console.log('FFmpeg concat command:', cmd))
          .on('progress', progress => console.log(`Progresso concat: ${progress.percent ? progress.percent.toFixed(2) : 0}%`))
          .on('end', resolve)
          .on('error', reject)
          .save(finalVideoPath);
      });
      console.log("✅ Vídeo final gerado:", finalVideoPath);

      // --- Enviar para YouTube ---
      console.log("📤 Enviando vídeo para o YouTube...");
      const oauth2Client = new google.auth.OAuth2(client_id, client_secret);
      oauth2Client.setCredentials({ refresh_token });

      const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
      const uploadResponse = await youtube.videos.insert({
        part: ['snippet', 'status'],
        requestBody: {
          snippet: { title, description },
          status: { privacyStatus: 'private', publishAt }
        },
        media: { body: fs.createReadStream(finalVideoPath) }
      });

      console.log("✅ Upload concluído. Video ID:", uploadResponse.data.id);
      res.json({ success: true, message: 'Vídeo enviado para o YouTube', videoId: uploadResponse.data.id });

    } catch (err) {
      console.error("❌ Erro no processamento:", err.message);
      res.status(500).json({ success: false, message: 'Erro no processamento', error: err.message });
    } finally {
      for (const file of tempFiles) {
        try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
      }
      console.log("🧹 Arquivos temporários limpos.");
    }
  }
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Render API rodando na porta ${PORT}`));
      
