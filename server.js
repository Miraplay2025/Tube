const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const sharp = require('sharp');
const { google } = require('googleapis');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '2gb' })); // permitir vídeos grandes

// Pasta temporária
const tempFolder = path.join(__dirname, 'videos');
if (!fs.existsSync(tempFolder)) fs.mkdirSync(tempFolder);

// --- Rota de upload/render ---
app.post('/upload', async (req, res) => {
  try {
    const {
      client_id,
      client_secret,
      refresh_token,
      title,
      description,
      publishAt,
      video,
      thumbnail
    } = req.body;

    // Validar campos obrigatórios
    if (!client_id || !client_secret || !refresh_token || !title || !description || !publishAt || !video || !thumbnail) {
      return res.status(400).json({ success: false, message: 'Todos os campos são obrigatórios' });
    }

    // --- Salvar vídeo ---
    const videoBuffer = Buffer.from(video, 'base64');
    const videoPath = path.join(tempFolder, `video_${Date.now()}.mp4`);
    fs.writeFileSync(videoPath, videoBuffer);

    // --- Salvar miniatura ---
    const thumbBuffer = Buffer.from(thumbnail, 'base64');
    const thumbPath = path.join(tempFolder, `thumb_${Date.now()}.jpg`);

    // Ajustar miniatura para proporção 9:16
    await sharp(thumbBuffer)
      .resize({ width: 1080, height: 1920, fit: 'cover' })
      .toFile(thumbPath);

    // --- Criar vídeo final com miniatura incorporada (1 segundo no início) ---
    const finalVideoPath = path.join(tempFolder, `final_${Date.now()}.mp4`);
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(thumbPath)
        .loop(1) // 1 segundo
        .input(videoPath)
        .complexFilter([
          '[0:v]scale=1080:1920,setsar=1[thumb]; [1:v]scale=1080:1920,setsar=1[vid]; [thumb][vid]concat=n=2:v=1:a=0[outv]'
        ])
        .outputOptions('-map [outv]')
        .save(finalVideoPath)
        .on('end', resolve)
        .on('error', reject);
    });

    // --- Enviar para YouTube ---
    const oauth2Client = new google.auth.OAuth2(client_id, client_secret);
    oauth2Client.setCredentials({ refresh_token });

    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

    const uploadResponse = await youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title,
          description
        },
        status: {
          privacyStatus: 'private',
          publishAt: publishAt
        }
      },
      media: {
        body: fs.createReadStream(finalVideoPath)
      }
    });

    // Limpeza temporária
    fs.unlinkSync(videoPath);
    fs.unlinkSync(thumbPath);
    fs.unlinkSync(finalVideoPath);

    res.json({ success: true, message: 'Vídeo enviado para o YouTube', videoId: uploadResponse.data.id });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Erro no processamento', error: err.message });
  }
});

// --- Start ---
const PORT = 3000;
app.listen(PORT, () => console.log(`Render API rodando na porta ${PORT}`));
