<?php
/* PXWA – gemeinsamer Einstieg für Web-Endpunkte und CLI-Skripte.
   Liegt außerhalb des Webroots (public/ bzw. public_html/). Keine Composer-Abhängigkeiten. */
declare(strict_types=1);

const PXWA_ROOT = __DIR__;

spl_autoload_register(static function (string $class): void {
    if (str_starts_with($class, 'Pxwa\\')) {
        require PXWA_ROOT . '/src/' . str_replace('\\', '/', substr($class, 5)) . '.php';
    }
});
require PXWA_ROOT . '/src/Errors.php';

ini_set('display_errors', '0');
ini_set('log_errors', '1');
ini_set('expose_php', '0');
date_default_timezone_set('UTC');

/* Konfiguration: server/config.php (nicht in Git). PXWA_CONFIG nur für lokale Tests. */
function pxwa_config(): Pxwa\Config
{
    static $config = null;
    return $config ??= Pxwa\Config::load(getenv('PXWA_CONFIG') ?: PXWA_ROOT . '/config.php');
}
