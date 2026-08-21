using System.Diagnostics;

namespace Gridsmith.Engine.Host;

/// <summary>
/// Uma amostra de telemetria: o que aconteceu na JANELA entre duas coletas,
/// não em um frame isolado.
///
/// <para><c>readonly record struct</c> de propósito — a amostra atravessa o
/// limite entre a thread de desenho e a do plano de controle a cada coleta, e
/// alocar por coleta contradiria a política Zero-GC justamente no caminho que
/// existe para medi-la.</para>
/// </summary>
/// <param name="Frames">Frames desenhados na janela. Zero é informação: a
/// janela existiu e o host não desenhou (minimizado, sem foco, travado).</param>
/// <param name="WindowMs">Duração real da janela, medida no host.</param>
/// <param name="DrawMsAvg">Tempo médio DENTRO do Draw.</param>
/// <param name="DrawMsMax">Pior frame da janela — é o que o usuário sente.</param>
/// <param name="CameraX">Posição com que o último frame foi desenhado.</param>
/// <param name="CameraY">Idem.</param>
/// <param name="Zoom">Idem.</param>
/// <param name="Quads">Quads desenhados no último frame.</param>
/// <param name="QuadsRequired">Quads que o frame PEDIU; maior que
/// <paramref name="Quads"/> quando o buffer truncou.</param>
/// <param name="Truncated">O último frame saiu truncado.</param>
public readonly record struct FrameTelemetrySample(
    int Frames,
    double WindowMs,
    double DrawMsAvg,
    double DrawMsMax,
    float CameraX,
    float CameraY,
    float Zoom,
    int Quads,
    int QuadsRequired,
    bool Truncated);

/// <summary>
/// Acumulador de telemetria do laço de desenho.
///
/// <para><b>Por que um acumulador e não um envio por frame:</b> o Draw roda a
/// 60 Hz e não pode fazer IPC — nem bloquear, nem alocar, nem depender de
/// haver um middleware conectado. Aqui ele apenas SOMA em campos já existentes
/// (custo de um lock não contendido) e quem envia é o plano de controle, na
/// cadência dele. As duas pontas ficam desacopladas: fechar o middleware não
/// muda uma linha do caminho de desenho.</para>
///
/// <para>A janela é medida por <see cref="Stopwatch"/> em vez de
/// <c>GameTime.ElapsedGameTime</c>: com <c>IsFixedTimeStep</c> ligado (o
/// default do MonoGame) o tempo do <c>GameTime</c> é o tempo NOMINAL do passo,
/// sempre 16,67 ms — reportá-lo como desempenho seria transformar telemetria
/// em uma constante bonita.</para>
/// </summary>
public sealed class FrameTelemetryProbe
{
    private readonly object _gate = new();

    private int _frames;
    private long _drawTicks;
    private long _worstDrawTicks;
    private long _windowStartTimestamp = Stopwatch.GetTimestamp();

    private float _cameraX;
    private float _cameraY;
    private float _zoom;
    private int _quads;
    private int _quadsRequired;
    private bool _truncated;
    private bool _everRecorded;

    /// <summary>
    /// Registra o frame recém-desenhado. Chamado do laço de desenho — sem
    /// alocação, sem I/O, sem await.
    /// </summary>
    public void Record(
        long drawTicks,
        float cameraX,
        float cameraY,
        float zoom,
        int quads,
        int quadsRequired,
        bool truncated)
    {
        lock (_gate)
        {
            _frames++;
            _drawTicks += drawTicks;
            if (drawTicks > _worstDrawTicks) _worstDrawTicks = drawTicks;

            // Estado do ÚLTIMO frame (não média): câmera e contagens são
            // instantâneas — a média de uma posição não descreve lugar nenhum.
            _cameraX = cameraX;
            _cameraY = cameraY;
            _zoom = zoom;
            _quads = quads;
            _quadsRequired = quadsRequired;
            _truncated = truncated;
            _everRecorded = true;
        }
    }

    /// <summary>
    /// Fecha a janela corrente e abre a próxima.
    /// </summary>
    /// <returns>
    /// <c>false</c> enquanto NENHUM frame tiver sido desenhado desde que o
    /// processo subiu — antes do primeiro frame não existe telemetria, e
    /// enviar zeros faria o middleware registrar um host parado que na verdade
    /// ainda estava carregando. Depois do primeiro frame a coleta sempre
    /// devolve amostra, inclusive com <c>Frames = 0</c>: parar de desenhar é
    /// exatamente o que o observador precisa ver.
    /// </returns>
    public bool TryTake(out FrameTelemetrySample sample)
    {
        lock (_gate)
        {
            if (!_everRecorded)
            {
                sample = default;
                return false;
            }

            var now = Stopwatch.GetTimestamp();
            var windowMs = TicksToMs(now - _windowStartTimestamp);
            sample = new FrameTelemetrySample(
                _frames,
                windowMs,
                _frames > 0 ? TicksToMs(_drawTicks) / _frames : 0,
                TicksToMs(_worstDrawTicks),
                _cameraX,
                _cameraY,
                _zoom,
                _quads,
                _quadsRequired,
                _truncated);

            _windowStartTimestamp = now;
            _frames = 0;
            _drawTicks = 0;
            _worstDrawTicks = 0;
            return true;
        }
    }

    private static double TicksToMs(long ticks) => ticks * 1000d / Stopwatch.Frequency;
}
