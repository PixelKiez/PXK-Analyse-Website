<?php
/* Rückkehr von der Google-Anmeldung (autorisierte Weiterleitungs-URI). Logik liegt außerhalb des Webroots. */
declare(strict_types=1);

require dirname(__DIR__, 2) . '/server/bootstrap.php';
Pxwa\App::run('callback');
