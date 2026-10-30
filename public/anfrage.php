<?php
/* Öffentlicher Einstieg für Anfrage, Bestätigung und Abmeldung. Logik liegt außerhalb des Webroots. */
declare(strict_types=1);

require dirname(__DIR__) . '/server/bootstrap.php';
Pxwa\App::run('request');
