<?php
declare(strict_types=1);

namespace Pxwa;

/* Minimaler HTTPS-Client (cURL) für die Google-Endpunkte. TLS-Prüfung bleibt immer aktiv. */
final class HttpClient
{
    public function __construct(private int $timeout = 10)
    {
    }

    /** @return array{status:int, body:string, headers:array<string,string>} */
    public function get(string $url): array
    {
        return $this->request($url, null);
    }

    /** @return array{status:int, body:string, headers:array<string,string>} */
    public function postForm(string $url, array $fields): array
    {
        return $this->request($url, http_build_query($fields, '', '&', PHP_QUERY_RFC3986));
    }

    private function request(string $url, ?string $postBody): array
    {
        $headers = [];
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS | CURLPROTO_HTTP,
            CURLOPT_CONNECTTIMEOUT => $this->timeout,
            CURLOPT_TIMEOUT => $this->timeout,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_HTTPHEADER => ['Accept: application/json'],
            CURLOPT_HEADERFUNCTION => static function ($ch, string $line) use (&$headers): int {
                $parts = explode(':', $line, 2);
                if (count($parts) === 2) {
                    $headers[strtolower(trim($parts[0]))] = trim($parts[1]);
                }
                return strlen($line);
            },
        ]);
        if ($postBody !== null) {
            curl_setopt($ch, CURLOPT_POST, true);
            curl_setopt($ch, CURLOPT_POSTFIELDS, $postBody);
        }
        $body = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        if ($body === false) {
            $status = 0;
            $body = '';
        }
        return ['status' => $status, 'body' => (string) $body, 'headers' => $headers];
    }
}
