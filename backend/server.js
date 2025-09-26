// =============================================================================
// ||               SERVIDOR BACKEND - LIMITADOR DE DISPOSITIVOS              ||
// =============================================================================

// --- Importações dos Módulos ---
const express = require("express"); // Framework para criar o servidor
const cors = require("cors"); // Middleware para permitir requisições de outros domínios
require("dotenv").config(); // Carrega variáveis de ambiente do arquivo .env
const { Pool } = require("pg"); // Driver do PostgreSQL para conectar ao Supabase
const nodemailer = require("nodemailer")
// --- Configuração do Banco de Dados ---
// Cria um "pool" de conexões com o banco de dados.
// O pool é mais eficiente do que criar uma conexão para cada requisição.
// A string de conexão é pega da variável de ambiente DATABASE_URL.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // A configuração SSL é frequentemente necessária para conexões com bancos de dados
  // na nuvem como o Supabase ou Heroku, para evitar erros de conexão.
  ssl: {
    rejectUnauthorized: false,
  },
});


const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",  // 🔹 aqui estava errado
  port: 465,               // SSL
  secure: true, 
  auth: {
    user: process.env.GMAIL_USER,   // seu usuário SMTP
    pass: process.env.GMAIL_KEY,   // sua senha SMTP ou token
  },
});

// --- Inicialização do Aplicativo Express ---
const app = express();
const PORT = process.env.PORT || 3000; // Usa a porta definida no ambiente ou a 3000
const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP; // ex: minha-loja.myshopify.com
const ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN; // token Admin API

// --- Middlewares Globais ---
// Habilita o CORS para que o frontend da sua loja Shopify possa fazer chamadas para este servidor.
app.use(cors());

// Habilita o Express a interpretar o corpo (body) das requisições que chegam em formato JSON.
app.use(express.json());

// =============================================================================
// ||                                  ROTAS                                  ||
// =============================================================================

/**
 * Rota de "saúde" (Health Check)
 * Usada para verificar rapidamente se o servidor está online e respondendo.
 */
app.get("/", (req, res) => {
  res.status(200).send("Servidor Shopify rodando!");
});

async function addCustomerTags(customerId, tags) {
  try {
    const response = await fetch(
      `https://${SHOPIFY_SHOP}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": ADMIN_API_TOKEN,
        },
        body: JSON.stringify({
          query: `
            mutation addTags($id: ID!, $tags: [String!]!) {
              tagsAdd(id: $id, tags: $tags) {
                node {
                  ... on Customer {
                    id
                    email
                    tags
                  }
                }
                userErrors {
                  field
                  message
                }
              }
            }
          `,
          variables: {
            id: `gid://shopify/Customer/${customerId}`,
            tags: tags,
          },
        }),
      }
    );

    const data = await response.json();

    if (data.errors) {
      console.error("Erro GraphQL:", data.errors);
      throw new Error(data.errors[0].message);
    }

    if (data.data.tagsAdd.userErrors.length > 0) {
      throw new Error(data.data.tagsAdd.userErrors[0].message);
    }

    return data.data.tagsAdd.node;
  } catch (error) {
    console.error("Erro em addCustomerTags:", error);
    throw error;
  }
}

app.post("/customer/verify_tag", async (req, res)=>{
  const {customerId} = req.body
  try {
    const response = await fetch(`https://${SHOPIFY_SHOP}/admin/api/2025-01/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": ADMIN_API_TOKEN,
      },
      body: JSON.stringify({
        query: `
          query getCustomer($id: ID!) {
            customer(id: $id) {
              id
              email
              firstName
              lastName
              tags
            }
          }
        `,
        variables: {
          id: `gid://shopify/Customer/${customerId}`, // <-- transforma o número no formato global ID
        },
      }),
    });

    const data = await response.json();
    const tags = data.data.customer.tags
    res.json(tags.includes("email_verified"))

  } catch (error) {
    console.error("Erro na chamada Shopify:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Rota Principal: /api/v1/check-device
 * Recebe o ID do cliente e o ID do dispositivo, verifica contra as regras de negócio
 * e retorna se o login é permitido ou negado.
 */
app.post("/api/v1/check-device", async (req, res) => {
  // 1. Extrai os dados do corpo da requisição.
  const { customerId, deviceIdentifier } = req.body;

  // 2. Valida se os dados necessários foram enviados.
  if (!customerId || !deviceIdentifier) {
    return res.status(400).json({
      status: "error",
      message: "As informações customerId e deviceIdentifier são obrigatórias.",
    });
  }

  console.log(`[REQUISIÇÃO] Cliente: ${customerId}, Dispositivo: ${deviceIdentifier}`);

  try {
    // 3. Verifica se o cliente existe na tabela 'customers'. Se não, cria com limite padrão.
    let customerDeviceLimit = 2; // Limite padrão

    const { rows: existingCustomer } = await pool.query(
      "SELECT device_limit FROM customers WHERE customer_id = $1",
      [customerId]
    );

    if (existingCustomer.length === 0) {
      // Cliente não existe, cria um novo registro com o limite padrão
      await pool.query(
        "INSERT INTO customers (customer_id, device_limit) VALUES ($1, $2)",
        [customerId, customerDeviceLimit]
      );
      console.log(`[REGISTRO] Novo cliente '${customerId}' criado com limite padrão de ${customerDeviceLimit} dispositivos.`);
    } else {
      // Cliente existe, usa o limite configurado para ele
      customerDeviceLimit = existingCustomer[0].device_limit;
    }

    // 4. Consulta o banco de dados para buscar os dispositivos já registrados para o cliente.
    const { rows: devices } = await pool.query(
      "SELECT device_identifier FROM customer_devices WHERE customer_id = $1",
      [customerId]
    );

    // 5. Verifica se o dispositivo atual já existe na lista de dispositivos registrados.
    const deviceExists = devices.some((d) => d.device_identifier === deviceIdentifier);

    // 6. Aplica a lógica de negócio com base no limite dinâmico.
    if (devices.length < customerDeviceLimit) {
      // CASO 1: O cliente tem menos dispositivos registrados que o limite.
      // O acesso é permitido. Se o dispositivo for novo, ele é registrado.
      if (!deviceExists) {
        await pool.query(
          "INSERT INTO customer_devices (customer_id, device_identifier) VALUES ($1, $2)",
          [customerId, deviceIdentifier]
        );
        console.log(
          `[REGISTRO] Novo dispositivo '${deviceIdentifier}' registrado para o cliente '${customerId}'.`
        );
      }
      console.log(
        `[REGISTRO - PERMITIDO] Cliente '${customerId}' tem ${devices.length} dispositivo(s) (limite: ${customerDeviceLimit}). Acesso permitido.`
      );
      return res.status(200).json({ status: "allowed" });
    } else {
      // CASO 2: O cliente já atingiu ou excedeu o limite de dispositivos.
      if (deviceExists) {
        // O dispositivo atual já é um dos registrados, então o acesso é permitido.
        console.log(
          `[REGISTRO - PERMITIDO] Dispositivo conhecido '${deviceIdentifier}' para o cliente '${customerId}'. Acesso permitido.`
        );
        return res.status(200).json({ status: "allowed" });
      } else {
        // O dispositivo é novo e o limite foi atingido, então o acesso é negado.
        console.log(
          `[REGISTRO - NEGADO] Cliente '${customerId}' atingiu o limite de ${customerDeviceLimit} dispositivos. Tentativa com novo dispositivo '${deviceIdentifier}' bloqueada.`
        );
        return res.status(403).json({
          status: "denied",
          message: `Você atingiu o limite de ${customerDeviceLimit} dispositivos.`, // Mensagem dinâmica
        });
      }
    }
  } catch (error) {
    // Em caso de qualquer erro com o banco de dados ou outra falha interna.
    console.error("[ERRO NO SERVIDOR]", error);
    return res.status(500).json({
      status: "error",
      message: "Ocorreu um erro interno no servidor.",
    });
  }
});

async function createCode(customerId){
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000); // expira em 10 minutos

  await pool.query(
    `INSERT INTO codigos_temp (user_id, code, expires_at)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id) 
    DO UPDATE SET code = $2, expires_at = $3`,
    [customerId, code, expiresAt]
  );

  console.log(
    `[REGISTRO] Novo código registrado para o cliente '${customerId}'.`
  );
  return code
}

async function existCode(userId){
  const now = Date.now();
  const { rows } = await pool.query(
    `SELECT code, expires_at FROM codigos_temp WHERE user_id = $1`,
    [userId]
  )
  if (rows.length > 0) {
    const existing = rows[0];
    const expiresAt = new Date(existing.expires_at).getTime();

    if (expiresAt > now) {
      // Código ainda válido
      return existing.code;
    } else {
      // Código expirou → gerar novo
      await pool.query("DELETE FROM codigos_temp WHERE user_id = $1", [userId]);
      const newCode = await createCode(userId);
      return newCode;
    }
  } else {
    // Nenhum código → criar novo
    const newCode = await createCode(userId);
    return newCode;
  }
}

app.post("/email/send", async (req, res)=>{
  const { customerId, customerEmail } = req.body
  const code = await existCode(customerId)
  console.log(`[EMAIL - ${customerEmail}] Enviando código de verificação`)
  try{

    const htmlContent = `
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Código de Verificação</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            background-color: #f4f6f8;
            margin: 0;
            padding: 0;
          }
          .email-container {
            max-width: 600px;
            margin: 40px auto;
            background-color: #ffffff;
            border-radius: 8px;
            overflow: hidden;
            box-shadow: 0 4px 10px rgba(0,0,0,0.1);
          }
          .header {
            background-color: #009EE0;
            padding: 20px;
            text-align: center;
          }
          .header img {
            max-width: 150px;
          }
          .content {
            padding: 30px 20px;
            color: #333333;
            text-align: center;
          }
          .content h1 {
            color: #15446D;
            font-size: 24px;
            margin-bottom: 20px;
          }
          .code {
            display: inline-block;
            background-color: #009EE0;
            color: #ffffff;
            font-size: 22px;
            font-weight: bold;
            padding: 10px 20px;
            border-radius: 6px;
            margin: 20px 0;
            letter-spacing: 2px;
          }
          .footer {
            background-color: #f0f2f5;
            color: #666666;
            font-size: 12px;
            text-align: center;
            padding: 15px 20px;
          }
          a {
            color: #15446D;
            text-decoration: none;
          }
        </style>
      </head>
      <body>
        <div class="email-container">
          <div class="header">
            <img src="https://br.eaata.pro/cdn/shop/files/Logo_EAATA_Brasil_Blanco_Bandera.webp?v=1746644575&width=160" alt="EAATA Brasil Logo">
          </div>
          <div class="content">
            <h1>Seu código de verificação</h1>
            <p>Use o código abaixo para concluir sua ação:</p>
            <div class="code">${code}</div>
            <p>Se você não solicitou este código, entregue em contato com a equipe EAATA informando.</p>
          </div>
          <div class="footer">
            &copy; ${new Date().getFullYear()} EAATA Brasil. Todos os direitos reservados.
          </div>
        </div>
      </body>
      </html>
      `;

    await transporter.sendMail({
      from: `"EAATA Brasil" <marketing.br@eaata.pro>`,
      to: customerEmail,
      subject: "Código de verificação",
      text: `Seu código é: ${code}`,
      html: htmlContent
    });

    return res.status(200).json({ status: "allowed" });
  }
  catch{
    console.log(`[EMAIL - ${customerEmail}] Falha no envio`)
    return res.status(400).json({ status: "disallowed" });
  }
})
app.post("/email/verify", async (req, res) => {
  const { customerId, customerShopifyId, customerCode } = req.body;

  try {
    const { rows } = await pool.query(
      `SELECT code, expires_at FROM codigos_temp WHERE user_id = $1`,
      [customerId]
    );

    if (rows.length === 0) {
      console.log(`[EMAIL - ${customerShopifyId}] Código não encontrado`);
      return res.status(400).json({ status: "disallowed", error: "Código não encontrado" });
    }

    const { code, expires_at } = rows[0];
    const now = new Date();

    // Verifica se o código expirou
    if (new Date(expires_at) < now) {
      // 🔹 Deleta o código expirado
      await pool.query("DELETE FROM codigos_temp WHERE user_id = $1", [customerId]);
      console.log(`[EMAIL - ${customerShopifyId}] Código expirado`);
      return res.status(400).json({ status: "disallowed", error: "Código expirado. Peça um novo no botão de reenviar!" });
    }

    // Verifica se o código corresponde
    if (customerCode === code) {
      await addCustomerTags(customerShopifyId, ['email_verified']);

      // 🔹 Deleta o código depois de usar
      await pool.query("DELETE FROM codigos_temp WHERE user_id = $1", [customerId]);
      console.log(`[EMAIL - ${customerShopifyId}] Email verificado`);
      return res.status(200).json({ status: "allowed" });
    } else {
      console.log(`[EMAIL - ${customerShopifyId}] Código inválido`);
      return res.status(400).json({ status: "disallowed", error: "Código inválido" });
    }

  } catch (error) {
    console.log(`[EMAIL - ${customerShopifyId}] Falha inesperada na verificação: ${error.message}`);
    return res.status(500).json({ status: "disallowed", error: error.message });
  }
});


// =============================================================================
// ||                         INICIALIZAÇÃO DO SERVIDOR                         ||
// =============================================================================
app.listen(PORT, () => {
  console.log(`[SERVIDOR] 🚀 Servidor rodando na porta http://localhost:${PORT}`);
});


