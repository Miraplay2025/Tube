# Use imagem oficial PHP com Apache
FROM php:8.2-apache

# Instala dependências: ffmpeg, curl, unzip, git, etc
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    unzip \
    git \
    && rm -rf /var/lib/apt/lists/*

# Habilita extensões PHP necessárias
RUN docker-php-ext-install mbstring json

# Copia arquivos do projeto para o diretório padrão do Apache
COPY . /var/www/html/

# Cria pasta para vídeos temporários
RUN mkdir -p /var/www/html/videos && chmod -R 777 /var/www/html/videos

# Expõe porta padrão do Apache
EXPOSE 80

# Start Apache em foreground
CMD ["apache2-foreground"]
