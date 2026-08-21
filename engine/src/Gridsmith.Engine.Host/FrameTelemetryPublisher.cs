using Gridsmith.Engine.Ipc;
using Gridsmith.Engine.Runtime;

namespace Gridsmith.Engine.Host;

/// <summary>
/// Publica a telemetria de frame como <b>notificação</b> JSON-RPC
/// (<c>frame/telemetry</c>), engine → middleware.
///
/// <para><b>Notificação, nunca request:</b> telemetria não tem resposta e não
/// pode fazer o desenho esperar por ninguém. Um request criaria a
/// possibilidade de o host bloquear em um middleware lento — o inverso do que
/// esta classe existe para permitir.</para>
///
/// <para><b>Este tipo mora no Host de propósito</b>, e a regra E6 afirma isso:
/// quem emite telemetria de frame é quem TEM frames. O
/// <c>Gridsmith.Engine.Runtime</c> headless não pode referenciar o Host (a
/// referência é a inversa), então "inventar telemetria sem desenhar" não é uma
/// tentação disponível — é um erro de compilação.</para>
/// </summary>
public static class FrameTelemetryPublisher
{
    public const string Method = "frame/telemetry";

    /// <summary>
    /// Cadência do fio. É o <b>tempo de detecção</b>: quanto o middleware pode
    /// demorar para perceber que a cena mudou. Não é a cadência do diário de
    /// eventos — essa é decidida no middleware, que coalesce as amostras
    /// (ADR-023); mandar a 60 Hz não deixaria nada mais observável, só
    /// gastaria o fio e o anel de eventos.
    /// </summary>
    public static readonly TimeSpan Interval = TimeSpan.FromSeconds(1);

    /// <summary>
    /// Monta o payload da notificação juntando a janela medida no desenho com
    /// as contagens da cena.
    ///
    /// <para>As contagens são lidas do serviço no momento do ENVIO, não no
    /// Draw: quem as muta é o plano de controle, e lê-las aqui evita que o
    /// laço de desenho toque estado que não é dele. A separação
    /// <c>frame</c> × <c>scene</c> no payload é honestidade, não estilo — o
    /// que o frame desenhou e o que a cena contém são números diferentes, e a
    /// onda A não desenha luz nenhuma.</para>
    /// </summary>
    public static object BuildParams(in FrameTelemetrySample sample, EngineService service) => new
    {
        frames = sample.Frames,
        windowMs = Round(sample.WindowMs),
        drawMsAvg = Round(sample.DrawMsAvg),
        drawMsMax = Round(sample.DrawMsMax),
        camera = new
        {
            x = Round(sample.CameraX),
            y = Round(sample.CameraY),
            zoom = Round(sample.Zoom),
        },
        frame = new
        {
            quads = sample.Quads,
            quadsRequired = sample.QuadsRequired,
            truncated = sample.Truncated,
        },
        scene = new
        {
            actors = service.Actors.LiveCount,
            lights = service.Lights.LiveCount,
            tilemaps = service.Tilemaps.LiveCount,
        },
    };

    /// <summary>
    /// Coleta a janela e notifica, quando houver o que notificar. Devolve
    /// <c>false</c> quando ainda não há telemetria (nenhum frame desenhado).
    /// </summary>
    public static async ValueTask<bool> PublishAsync(
        JsonRpcConnection connection,
        FrameTelemetryProbe probe,
        EngineService service,
        CancellationToken ct)
    {
        if (!probe.TryTake(out var sample))
        {
            return false;
        }

        await connection.NotifyAsync(Method, BuildParams(in sample, service), ct).ConfigureAwait(false);
        return true;
    }

    private static double Round(double value) => Math.Round(value, 3);
}
