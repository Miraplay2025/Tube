const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const sharp = require('sharp');
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
    const tempFiles = []; // lista de arquivos para exclusão depois

    try {
      const { title, description, publishAt, videoUrl } = req.body;

      // Validar campos básicos
      if (!title || !description || !publishAt || !videoUrl) {
        return res.status(400).json({ success: false, message: 'Todos os campos de texto são obrigatórios' });
      }

      // --- Carregar credenciais ---
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

      // --- Processar miniatura ---
      if (!req.files['thumbnail']) {
        return res.status(400).json({ success: false, message: 'Miniatura é obrigatória' });
      }
      const thumbPath = req.files['thumbnail'][0].path;
      const resizedThumb = path.join(tempFolder, `thumb_${Date.now()}.jpg`);
      tempFiles.push(thumbPath, resizedThumb);

      console.log("🖼️ Processando miniatura...");
      await sharp(thumbPath)
        .resize({ width: 1080, height: 1920, fit: 'cover' })
        .toFile(resizedThumb);
      console.log("✅ Miniatura redimensionada:", resizedThumb);

      // --- Criar vídeo final ---
      const finalVideoPath = path.join(tempFolder, `final_${Date.now()}.mp4`);
      tempFiles.push(finalVideoPath);

      console.log("🎬 Gerando vídeo final com miniatura no início...");
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(resizedThumb)
          .loop(1)
          .input(videoPath)
          .complexFilter([
            '[0:v]scale=1080:1920,setsar=1[thumb]; [1:v]scale=1080:1920,setsar=1[vid]; [thumb][vid]concat=n=2:v=1:a=0[outv]'
          ])
          .outputOptions('-map [outv]')
          .save(finalVideoPath)
          .on('end', resolve)
          .on('error', reject);
      });
      console.log("✅ Vídeo final gerado:", finalVideoPath);

      // --- Enviar para YouTube ---
      console.log("📤 Enviando vídeo para YouTube...");
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
      // Limpeza dos arquivos temporários
      for (const file of tempFiles) {
        try {
          if (fs.existsSync(file)) fs.unlinkSync(file);
        } catch {}
      }
      console.log("🧹 Arquivos temporários limpos.");
    }
  }
);

// --- Start ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Render API rodando na porta ${PORT}`));
    
