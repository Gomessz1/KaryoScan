# KaryoScan — Servidor de Licenças e Autenticação

Servidor Node.js que gerencia autenticação institucional, contratos de licença e usuários do KaryoScan.

## Tecnologias

- **Node.js** 18+ + **Express** 4
- **SQLite** via `better-sqlite3` (banco local, zero configuração)
- **JWT** via `jsonwebtoken` (tokens 12h)
- **bcryptjs** para hash de senhas

---

## Instalação Rápida (Desenvolvimento)

```bash
cd backend
npm install
cp .env.example .env
# Edite o .env com suas configurações
node server.js
```

Acesse:
- Aplicação: http://localhost:3000
- Admin: http://localhost:3000/admin.html
- Landing: http://localhost:3000/landing.html

Na primeira execução, o superadmin é criado automaticamente com as credenciais do `.env`.

---

## Configurar o Frontend para Usar o Servidor

Ao abrir `login.html`, passe o endereço do backend como parâmetro:

```
http://localhost:3000/login.html?backend=http://localhost:3000
```

Ou configure diretamente no console do navegador:

```javascript
localStorage.setItem('ks_backend', 'http://localhost:3000');
```

---

## Deploy em VPS (Ubuntu/Debian)

### 1. Instalar Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. Subir os arquivos

Copie a pasta `KaryoScan` inteira para o servidor (ex: `/var/www/karyoscan`).

```bash
cd /var/www/karyoscan/backend
npm install --omit=dev
cp .env.example .env
nano .env   # edite JWT_SECRET, ADMIN_PASSWORD e ALLOWED_ORIGINS
```

### 3. Rodar com PM2 (processo persistente)

```bash
npm install -g pm2
pm2 start server.js --name karyoscan
pm2 save
pm2 startup   # siga as instruções para ativar no boot
```

### 4. Nginx como proxy reverso

```nginx
server {
    listen 80;
    server_name karyoscan.seudominio.com.br;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
    }
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 5. SSL com Let's Encrypt

```bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d karyoscan.seudominio.com.br
```

---

## API Reference

### Auth

| Método | Rota | Descrição |
|--------|------|-----------|
| `POST` | `/api/auth/login` | Login — retorna JWT |
| `GET`  | `/api/auth/verify` | Verifica token e validade da licença |

**POST /api/auth/login**
```json
{ "email": "user@lab.com", "password": "senha123" }
```
Retorna:
```json
{ "token": "...", "user": { "id": 1, "name": "Ana", "role": "user" } }
```
Erros: `401` credenciais inválidas · `403` licença expirada

**GET /api/auth/verify** (Authorization: Bearer `<token>`)
```json
{ "valid": true, "user": {...}, "daysLeft": 412, "plan": "profissional" }
```

### Admin (requer role admin ou superadmin)

| Método  | Rota | Descrição |
|---------|------|-----------|
| `GET`   | `/api/admin/dashboard` | Stats + licenças vencendo |
| `GET`   | `/api/admin/institutions` | Lista clientes |
| `POST`  | `/api/admin/institutions` | Cadastrar cliente |
| `GET`   | `/api/admin/licenses` | Lista licenças |
| `POST`  | `/api/admin/licenses` | Adicionar/renovar licença |
| `GET`   | `/api/admin/users` | Lista usuários |
| `POST`  | `/api/admin/users` | Criar usuário |
| `PATCH` | `/api/admin/users/:id` | Ativar/desativar usuário |

---

## Banco de Dados

O banco SQLite é criado automaticamente em `backend/karyoscan.db` na primeira execução.
**Faça backup deste arquivo regularmente.**

Para VPS:
```bash
# Backup diário (crontab)
0 3 * * * cp /var/www/karyoscan/backend/karyoscan.db /backups/karyoscan_$(date +\%Y\%m\%d).db
```

---

## Segurança em Produção

- ✅ Altere `JWT_SECRET` para uma string aleatória de 64+ caracteres
- ✅ Altere `ADMIN_PASSWORD` para uma senha forte
- ✅ Configure `ALLOWED_ORIGINS` com seu domínio real
- ✅ Use HTTPS (Let's Encrypt)
- ✅ Mantenha Node.js e dependências atualizados
- ✅ Configure firewall para expor apenas as portas 80/443
- ✅ Faça backups regulares do `karyoscan.db`
