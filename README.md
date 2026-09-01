# INTEGRAÇÃO-PACS

## Introdução

Componente para ser executado no ambiente local do cliente, para recebimentos dos arquivos de worklist e gravação desses arquivos na pasta configurada no arquivo .env.

Os arquivos de worklist são gerados quando é realizado o atendimento do paciente no klingo.

## Sobre

Integração entre o Klingo e o Pacs/Carestream.

## Requisitos

1. NodeJS

## Instalação

Fazer o download do NodeJS (https://nodejs.org/) e instalar.

## Download do projeto e das dependências

Deve ser criado um diretório aonde ficará armazenada a aplicação. De dentro do diretório, via linha de comando deve ser executado o comando abaixo para baixar o projeto.

    git clone https://github.com/azuremed/integracao-pacs
    cd integracao-pacs
    cp .env.exemplo .env
    npm install

## Configurar a aplicação

Entre em contato com o suporte do Klingo para configurar as variáveis de ambiente no arquivo ".env"

## Rodando a aplicação

Executar o comando abaixo:

    node unificado.js

## Gerando o .exe
ex.: rodar comando para gerar o executavel 
pkg unificado.js --target node18-win-x64 --output fuji.exe

### Pronto!
