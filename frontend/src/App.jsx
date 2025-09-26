import { Page, Layout, Form, FormLayout, TextField, Button, Banner } from '@shopify/polaris';
import { useState, useEffect } from 'react';

export default function SettingsForm() {
  const [maxDevices, setMaxDevices] = useState('');
  const [blockMessage, setBlockMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    // Busca config inicial da API
    fetch('/api/settings')
      .then(res => res.json())
      .then(data => {
        setMaxDevices(data.max_devices?.toString() || '2');
        setBlockMessage(data.block_message || '');
      });
  }, []);

  function validate() {
    if (!maxDevices || isNaN(maxDevices) || parseInt(maxDevices, 10) < 1) {
      setError('O limite de dispositivos deve ser um número inteiro maior que zero.');
      return false;
    }
    if (!blockMessage.trim()) {
      setError('A mensagem de bloqueio não pode estar vazia.');
      return false;
    }
    setError('');
    return true;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!validate()) return;

    setLoading(true);
    setSuccess('');
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          max_devices: parseInt(maxDevices, 10),
          block_message: blockMessage,
        }),
      });
      if (res.ok) {
        setSuccess('Configurações salvas com sucesso!');
      } else {
        const err = await res.json();
        setError(err.error || 'Erro ao salvar as configurações.');
      }
    } catch {
      setError('Erro ao conectar com o servidor.');
    }
    setLoading(false);
  }

  return (
    <Page title="Configuração do Limite de Dispositivos">
      <Layout>
        <Layout.Section>
          {error && <Banner status="critical" onDismiss={() => setError('')}>{error}</Banner>}
          {success && <Banner status="success" onDismiss={() => setSuccess('')}>{success}</Banner>}
          <Form onSubmit={handleSubmit}>
            <FormLayout>
              <TextField
                label="Limite máximo de dispositivos"
                type="number"
                value={maxDevices}
                onChange={(value) => setMaxDevices(value)}
                min={1}
                helpText="Número máximo de dispositivos permitidos por conta."
                required
              />
              <TextField
                label="Mensagem exibida ao ultrapassar o limite"
                value={blockMessage}
                onChange={setBlockMessage}
                multiline
                minLines={3}
                maxLines={6}
                placeholder="Ex: Você já está logado em muitos dispositivos."
                required
              />
              <Button submit primary loading={loading}>
                Salvar Configurações
              </Button>
            </FormLayout>
          </Form>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
