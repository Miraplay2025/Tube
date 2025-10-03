FROM node:20

# Criar pasta da aplicação
WORKDIR /app

# Copiar arquivos
COPY package*.json ./
RUN npm install

COPY . .

# Instalar ffmpeg no container
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

# Porta exposta
EXPOSE 3000

# Comando para iniciar
CMD ["npm", "start"]
