<?php
declare(strict_types=1);

namespace Pxwa;

/* Schlanker SMTP-Client (implizites TLS oder STARTTLS, AUTH LOGIN) nur für die interne Benachrichtigung.
   Kopfzeilen werden gegen Header-Injection bereinigt, Text wird base64-kodiert übertragen. */
final class SmtpMailer
{
    /** @var resource|null */
    private $fp = null;

    public function __construct(private array $cfg)
    {
    }

    public function send(string $to, string $subject, string $text, ?string $replyTo = null): void
    {
        foreach (array_filter([$to, $this->cfg['from'], $replyTo]) as $address) {
            if (!filter_var($address, FILTER_VALIDATE_EMAIL) || preg_match('/[\r\n<>]/', $address)) {
                throw new MailError('protocol');
            }
        }
        try {
            $this->open();
            $this->command('MAIL FROM:<' . $this->cfg['from'] . '>', [250]);
            $this->command('RCPT TO:<' . $to . '>', [250, 251]);
            $this->command('DATA', [354]);
            $this->write(self::dotStuff($this->message($to, $subject, $text, $replyTo)) . "\r\n.");
            $this->expect([250]);
            try {
                $this->command('QUIT', [221]);
            } catch (MailError) {
                /* Nachricht ist bereits angenommen */
            }
        } finally {
            if ($this->fp) {
                fclose($this->fp);
                $this->fp = null;
            }
        }
    }

    private function open(): void
    {
        $host = $this->cfg['host'];
        $enc = $this->cfg['encryption'];
        $ctx = stream_context_create(['ssl' => ['verify_peer' => true, 'verify_peer_name' => true, 'peer_name' => $host, 'SNI_enabled' => true]]);
        $fp = @stream_socket_client(($enc === 'ssl' ? 'ssl://' : 'tcp://') . $host . ':' . (int) $this->cfg['port'], $errno, $errstr, (float) $this->cfg['timeout'], STREAM_CLIENT_CONNECT, $ctx);
        if (!$fp) {
            throw new MailError($enc === 'ssl' ? 'tls' : 'connect');
        }
        $this->fp = $fp;
        stream_set_timeout($fp, (int) $this->cfg['timeout']);
        $this->expect([220]);
        $ehlo = 'EHLO ' . (parse_url('http://' . ($this->cfg['ehlo'] ?? 'localhost'), PHP_URL_HOST) ?: 'localhost');
        $this->command($ehlo, [250]);
        if ($enc === 'starttls') {
            $this->command('STARTTLS', [220]);
            if (!stream_socket_enable_crypto($fp, true, STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT | STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT)) {
                throw new MailError('tls');
            }
            $this->command($ehlo, [250]);
        }
        if ($this->cfg['username'] !== '') {
            $this->command('AUTH LOGIN', [334]);
            $this->command(base64_encode($this->cfg['username']), [334], true);
            $this->command(base64_encode($this->cfg['password']), [235], true);
        }
    }

    private function message(string $to, string $subject, string $text, ?string $replyTo): string
    {
        $domain = substr(strrchr($this->cfg['from'], '@'), 1);
        $headers = [
            'Date: ' . date(DATE_RFC2822),
            'From: ' . self::encode(self::clean($this->cfg['from_name'])) . ' <' . $this->cfg['from'] . '>',
            'To: <' . $to . '>',
            'Subject: ' . self::encode(self::clean($subject)),
            'Message-ID: <' . bin2hex(random_bytes(12)) . '@' . $domain . '>',
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=UTF-8',
            'Content-Transfer-Encoding: base64',
            'Auto-Submitted: auto-generated',
        ];
        if ($replyTo !== null) {
            $headers[] = 'Reply-To: <' . $replyTo . '>';
        }
        return implode("\r\n", $headers) . "\r\n\r\n" . rtrim(chunk_split(base64_encode($text), 76, "\r\n"));
    }

    private static function clean(string $s): string
    {
        return trim(preg_replace('/[\x00-\x1f\x7f]+/', ' ', $s));
    }

    private static function encode(string $s): string
    {
        return preg_match('/[^\x20-\x7e]/', $s) ? '=?UTF-8?B?' . base64_encode($s) . '?=' : $s;
    }

    private static function dotStuff(string $data): string
    {
        $lf = preg_replace('/^\./m', '..', str_replace(["\r\n", "\r"], "\n", $data));
        return str_replace("\n", "\r\n", $lf);
    }

    private function command(string $line, array $expect, bool $secret = false): string
    {
        $this->write($line);
        return $this->expect($expect, $secret);
    }

    private function write(string $data): void
    {
        if (fwrite($this->fp, $data . "\r\n") === false) {
            throw new MailError('connect');
        }
    }

    private function expect(array $codes, bool $afterAuth = false): string
    {
        $response = '';
        while (($line = fgets($this->fp, 1024)) !== false) {
            $response .= $line;
            if (strlen($line) < 4 || $line[3] !== '-') {
                break;
            }
        }
        $code = (int) substr($response, 0, 3);
        if ($response === '' || $code === 0) {
            throw new MailError('connect');
        }
        if (!in_array($code, $codes, true)) {
            /* Antworttext nicht übernehmen: er kann Adressen enthalten */
            throw new MailError($afterAuth || $code === 535 ? 'auth' : ($code >= 500 ? 'permanent' : 'temporary'), $code);
        }
        return $response;
    }
}
