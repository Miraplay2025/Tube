<?php
set_time_limit(0);
header('Content-Type: text/plain; charset=utf-8');

// --- Função de log ---
function logMsg($msg){
    echo "[".date('H:i:s')."] $msg\n";
    flush();
}

// --- Receber dados ---
$driveLink = $_POST['drive_link'] ?? '';
$titulo    = $_POST['titulo'] ?? '';
$descricao = $_POST['descricao'] ?? '';
$dataPub   = $_POST['data'] ?? '';
$thumbVideo = $_FILES['miniatura'] ?? null;
$configFile = $_FILES['youtube_config'] ?? null;

if(!$driveLink || !$titulo || !$descricao || !$dataPub || !$thumbVideo || $thumbVideo['error']!==0 || !$configFile || $configFile['error']!==0){
    logMsg("Todos os campos são obrigatórios");
    exit;
}

// --- Ler configuração do YouTube ---
$configContent = file_get_contents($configFile['tmp_name']);
$config = json_decode($configContent,true);
if(!$config || !isset($config['client_id'],$config['client_secret'],$config['refresh_token'])){
    logMsg("Configuração do YouTube inválida");
    exit;
}
$client_id = $config['client_id'];
$client_secret = $config['client_secret'];
$refresh_token = $config['refresh_token'];

logMsg("Configuração do YouTube carregada");

// --- Pastas ---
$videoFolder = __DIR__.'/videos';
if(!is_dir($videoFolder)) mkdir($videoFolder,0777,true);

// --- Extrair FILE_ID do Google Drive ---
if(preg_match('/\/d\/([a-zA-Z0-9_-]+)/',$driveLink,$matches)){
    $fileId = $matches[1];
    logMsg("FILE_ID extraído: $fileId");
}else{
    logMsg("Link do Google Drive inválido");
    exit;
}
$downloadUrl = "https://drive.google.com/uc?export=download&id=$fileId";

// --- Baixar vídeo principal ---
$videoFile = $videoFolder.'/video_main_'.time().'.mp4';
logMsg("Iniciando download do Drive...");
$ch = curl_init($downloadUrl);
curl_setopt($ch,CURLOPT_RETURNTRANSFER,true);
curl_setopt($ch,CURLOPT_FOLLOWLOCATION,true);
curl_setopt($ch,CURLOPT_SSL_VERIFYPEER,false);
$videoContent = curl_exec($ch);
$httpCode = curl_getinfo($ch,CURLINFO_HTTP_CODE);
curl_close($ch);

if($httpCode!=200 || !$videoContent){
    logMsg("Erro ao baixar vídeo do Drive");
    exit;
}
file_put_contents($videoFile,$videoContent);
logMsg("Vídeo do Drive baixado: ".filesize($videoFile)." bytes");

// --- Salvar miniatura ---
$thumbFile = $videoFolder.'/thumb_'.time().'.mp4';
move_uploaded_file($thumbVideo['tmp_name'],$thumbFile);
logMsg("Miniatura salva: $thumbFile");

// --- Concatenar vídeos ---
$finalFile = $videoFolder.'/final_'.time().'.mp4';
$concatFile = $videoFolder.'/concat.txt';
file_put_contents($concatFile,"file '$thumbFile'\nfile '$videoFile'\n");
$cmd = "ffmpeg -y -f concat -safe 0 -i $concatFile -c copy $finalFile 2>&1";
logMsg("Executando FFmpeg: $cmd");
exec($cmd,$output,$return_var);
if($return_var!==0){
    logMsg("Erro FFmpeg: ".implode("\n",$output));
    exit;
}
logMsg("Vídeos concatenados: $finalFile");

// --- Gerar Access Token ---
$tokenUrl = "https://oauth2.googleapis.com/token";
$postFields = http_build_query([
    'client_id'=>$client_id,
    'client_secret'=>$client_secret,
    'refresh_token'=>$refresh_token,
    'grant_type'=>'refresh_token'
]);
$ch = curl_init($tokenUrl);
curl_setopt($ch,CURLOPT_POST,true);
curl_setopt($ch,CURLOPT_POSTFIELDS,$postFields);
curl_setopt($ch,CURLOPT_RETURNTRANSFER,true);
curl_setopt($ch,CURLOPT_SSL_VERIFYPEER,false);
$tokenResp = curl_exec($ch);
curl_close($ch);
$tokenData = json_decode($tokenResp,true);
if(!isset($tokenData['access_token'])){
    logMsg("Não foi possível gerar Access Token");
    exit;
}
$accessToken = $tokenData['access_token'];
logMsg("Access Token obtido");

// --- Iniciar upload resumido ---
$uploadUrl = "https://www.googleapis.com/upload/youtube/v3/videos?part=snippet,status";
$snippet = ["title"=>$titulo,"description"=>$descricao];
$status  = ["privacyStatus"=>"private","publishAt"=>$dataPub];
$postData = ["snippet"=>$snippet,"status"=>$status];
$headers = [
    "Authorization: Bearer $accessToken",
    "Content-Type: application/json; charset=UTF-8",
    "X-Upload-Content-Type: video/*",
    "X-Upload-Content-Length: ".filesize($finalFile)
];
$ch = curl_init($uploadUrl."&uploadType=resumable");
curl_setopt($ch,CURLOPT_RETURNTRANSFER,true);
curl_setopt($ch,CURLOPT_HTTPHEADER,$headers);
curl_setopt($ch,CURLOPT_POST,true);
curl_setopt($ch,CURLOPT_POSTFIELDS,json_encode($postData));
curl_setopt($ch,CURLOPT_HEADER,true);
curl_setopt($ch,CURLOPT_SSL_VERIFYPEER,false);
$resumeResp = curl_exec($ch);
$headerSize = curl_getinfo($ch,CURLINFO_HEADER_SIZE);
$headersResp = substr($resumeResp,0,$headerSize);
curl_close($ch);

// --- Capturar Location ---
if(!preg_match('/Location:\s*(.*)\r/i',$headersResp,$matches)){
    logMsg("Erro ao iniciar upload: $headersResp");
    exit;
}
$uploadLocation = trim($matches[1]);
logMsg("Upload resumido iniciado");

// --- Upload chunks de 5MB ---
$chunkSize = 5*1024*1024;
$fp = fopen($finalFile,'rb');
$fileSize = filesize($finalFile);
$start=0;

while($start<$fileSize){
    $end = min($start+$chunkSize-1,$fileSize-1);
    $length = $end-$start+1;
    $chunk = fread($fp,$length);
    logMsg("Enviando chunk $start-$end...");
    $ch = curl_init($uploadLocation);
    curl_setopt($ch,CURLOPT_CUSTOMREQUEST,"PUT");
    curl_setopt($ch,CURLOPT_HTTPHEADER,[
        "Authorization: Bearer $accessToken",
        "Content-Length: $length",
        "Content-Range: bytes $start-$end/$fileSize",
        "Content-Type: video/*"
    ]);
    curl_setopt($ch,CURLOPT_RETURNTRANSFER,true);
    curl_setopt($ch,CURLOPT_POSTFIELDS,$chunk);
    curl_setopt($ch,CURLOPT_SSL_VERIFYPEER,false);
    $result = curl_exec($ch);
    $error = curl_error($ch);
    curl_close($ch);
    if($result===false){
        logMsg("Erro no chunk $start-$end: $error");
        exit;
    }
    logMsg("Chunk $start-$end enviado");
    $start=$end+1;
}
fclose($fp);

// --- Limpeza ---
unlink($thumbFile);
unlink($videoFile);
unlink($finalFile);
unlink($concatFile);
logMsg("Arquivos temporários removidos");

// --- Capturar ID do vídeo ---
$videoResp = json_decode($result,true);
$videoId = $videoResp['id'] ?? null;
if(!$videoId){
    logMsg("Vídeo enviado mas ID não retornado");
    exit;
}
logMsg("Upload concluído: Video ID = $videoId");

?>
