const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const WebSocket = require('ws');

const app = express();
const PORT = 3000;

require('dotenv').config();

// Middleware
app.use(cors());
app.use(express.json());

// Configuração do PostgreSQL
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false }
});

module.exports = pool;

// ============================================
// CRIAR TABELAS (rodar uma vez)
// ============================================
async function criarTabelas() {
  try {
    // Tabela de usuários
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL,
        telefone VARCHAR(20) UNIQUE NOT NULL,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Tabela de mensagens
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mensagens (
        id SERIAL PRIMARY KEY,
        remetente_id INT NOT NULL,
        destinatario_id INT NOT NULL,
        texto TEXT NOT NULL,
        enviado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (remetente_id) REFERENCES usuarios(id),
        FOREIGN KEY (destinatario_id) REFERENCES usuarios(id)
      )
    `);

    console.log('✅ Tabelas criadas com sucesso!');
  } catch (error) {
    console.error('❌ Erro ao criar tabelas:', error);
  }
}

criarTabelas();

// ============================================
// ROTAS DA API
// ============================================

// 1. CRIAR USUÁRIO
app.post('/usuarios', async (req, res) => {
  const { nome, telefone } = req.body;
  
  try {
    const resultado = await pool.query(
      'INSERT INTO usuarios (nome, telefone) VALUES ($1, $2) RETURNING *',
      [nome, telefone]
    );
    res.json(resultado.rows[0]);
  } catch (error) {
    res.status(400).json({ erro: 'Usuário já existe ou erro ao criar' });
  }
});

// 2. LISTAR TODOS OS USUÁRIOS (contatos)
app.get('/usuarios', async (req, res) => {
  try {
    const resultado = await pool.query('SELECT * FROM usuarios ORDER BY nome');
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ erro: 'Erro ao buscar usuários' });
  }
});

// 3. ENVIAR MENSAGEM
app.post('/mensagens', async (req, res) => {
  const { remetente_id, destinatario_id, texto } = req.body;
  
  try {
    const resultado = await pool.query(
      'INSERT INTO mensagens (remetente_id, destinatario_id, texto) VALUES ($1, $2, $3) RETURNING *',
      [remetente_id, destinatario_id, texto]
    );
    
    const mensagem = resultado.rows[0];
    
    // Notificar via WebSocket
    notificarNovaMensagem(mensagem);
    
    res.json(mensagem);
  } catch (error) {
    res.status(400).json({ erro: 'Erro ao enviar mensagem' });
  }
});

// 4. BUSCAR CONVERSA ENTRE DOIS USUÁRIOS
app.get('/mensagens/:usuario1_id/:usuario2_id', async (req, res) => {
  const { usuario1_id, usuario2_id } = req.params;
  
  try {
    const resultado = await pool.query(`
      SELECT m.*, 
             u1.nome as remetente_nome,
             u2.nome as destinatario_nome
      FROM mensagens m
      JOIN usuarios u1 ON m.remetente_id = u1.id
      JOIN usuarios u2 ON m.destinatario_id = u2.id
      WHERE 
        (m.remetente_id = $1 AND m.destinatario_id = $2)
        OR
        (m.remetente_id = $2 AND m.destinatario_id = $1)
      ORDER BY m.enviado_em ASC
    `, [usuario1_id, usuario2_id]);
    
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ erro: 'Erro ao buscar mensagens' });
  }
});

// 5. BUSCAR ÚLTIMAS CONVERSAS DE UM USUÁRIO
app.get('/conversas/:usuario_id', async (req, res) => {
  const { usuario_id } = req.params;
  
  try {
    const resultado = await pool.query(`
      SELECT DISTINCT ON (outro_usuario_id)
        outro_usuario_id,
        outro_usuario_nome,
        ultima_mensagem,
        enviado_em
      FROM (
        SELECT 
          CASE 
            WHEN m.remetente_id = $1 THEN m.destinatario_id
            ELSE m.remetente_id
          END as outro_usuario_id,
          CASE 
            WHEN m.remetente_id = $1 THEN u2.nome
            ELSE u1.nome
          END as outro_usuario_nome,
          m.texto as ultima_mensagem,
          m.enviado_em
        FROM mensagens m
        JOIN usuarios u1 ON m.remetente_id = u1.id
        JOIN usuarios u2 ON m.destinatario_id = u2.id
        WHERE m.remetente_id = $1 OR m.destinatario_id = $1
        ORDER BY m.enviado_em DESC
      ) sub
      ORDER BY outro_usuario_id, enviado_em DESC
    `, [usuario_id]);
    
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ erro: 'Erro ao buscar conversas' });
  }
});

// ============================================
// WEBSOCKET - TEMPO REAL
// ============================================

const server = app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});

const wss = new WebSocket.Server({ server });

// Armazena conexões dos usuários
const conexoes = new Map();

wss.on('connection', (ws) => {
  console.log('👤 Novo cliente conectado');
  
  // Recebe ID do usuário quando conecta
  ws.on('message', (mensagem) => {
    const dados = JSON.parse(mensagem);
    
    if (dados.tipo === 'registrar') {
      conexoes.set(dados.usuario_id, ws);
      console.log(`✅ Usuário ${dados.usuario_id} registrado no WebSocket`);
    }
  });
  
  ws.on('close', () => {
    // Remove conexão quando desconecta
    for (let [usuario_id, socket] of conexoes.entries()) {
      if (socket === ws) {
        conexoes.delete(usuario_id);
        console.log(`❌ Usuário ${usuario_id} desconectado`);
      }
    }
  });
});

// Função para notificar usuário sobre nova mensagem
function notificarNovaMensagem(mensagem) {
  const wsDestinatario = conexoes.get(mensagem.destinatario_id);
  
  if (wsDestinatario && wsDestinatario.readyState === WebSocket.OPEN) {
    wsDestinatario.send(JSON.stringify(mensagem));
    console.log(`📨 Mensagem enviada para usuário ${mensagem.destinatario_id}`);
  }
}

// ============================================
// ROTA DE TESTE
// ============================================
app.get('/', (req, res) => {
  res.json({ 
    status: 'Servidor funcionando!',
    rotas: {
      'POST /usuarios': 'Criar usuário',
      'GET /usuarios': 'Listar usuários',
      'POST /mensagens': 'Enviar mensagem',
      'GET /mensagens/:usuario1_id/:usuario2_id': 'Buscar conversa',
      'GET /conversas/:usuario_id': 'Últimas conversas'
    }
  });
});