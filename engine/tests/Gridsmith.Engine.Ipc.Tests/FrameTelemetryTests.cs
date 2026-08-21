using System.Numerics;
using System.Text.Json;
using Gridsmith.Engine.Core.Lighting;
using Gridsmith.Engine.Host;
using Gridsmith.Engine.Runtime;
using Xunit;

namespace Gridsmith.Engine.Ipc.Tests;

/// <summary>
/// Telemetria de frame do host gráfico (ADR-023).
///
/// O probe é testável sem GPU porque é só um acumulador: o que ele mede vem do
/// laço de desenho, mas ele não sabe desenhar. O <see cref="GridsmithGame"/>
/// continua fora do alcance do CI — e é justamente por isso que a medição mora
/// aqui e não lá dentro.
/// </summary>
public class FrameTelemetryTests
{
    private static long MsToTicks(double ms) => (long)(ms * System.Diagnostics.Stopwatch.Frequency / 1000d);

    [Fact]
    public void Antes_do_primeiro_frame_nao_existe_telemetria()
    {
        var probe = new FrameTelemetryProbe();

        Assert.False(probe.TryTake(out _));
    }

    [Fact]
    public void A_janela_agrega_os_frames_e_reabre_vazia()
    {
        var probe = new FrameTelemetryProbe();
        probe.Record(MsToTicks(2), 10f, 20f, 1f, quads: 30, quadsRequired: 30, truncated: false);
        probe.Record(MsToTicks(8), 11f, 21f, 2f, quads: 40, quadsRequired: 44, truncated: true);

        Assert.True(probe.TryTake(out var first));
        Assert.Equal(2, first.Frames);
        Assert.Equal(5, first.DrawMsAvg, 1);
        // O pior frame é reportado à parte porque é ele que o usuário sente;
        // uma média de 5 ms esconderia o engasgo de 8.
        Assert.Equal(8, first.DrawMsMax, 1);
        // Câmera e contagens são do ÚLTIMO frame — média de posição não é lugar.
        Assert.Equal(11f, first.CameraX);
        Assert.Equal(21f, first.CameraY);
        Assert.Equal(2f, first.Zoom);
        Assert.Equal(40, first.Quads);
        Assert.Equal(44, first.QuadsRequired);
        Assert.True(first.Truncated);

        // Segunda coleta sem nenhum frame novo: a janela existiu e nada foi
        // desenhado. Isso É a informação — parar de desenhar tem de ser
        // observável, não silencioso.
        Assert.True(probe.TryTake(out var second));
        Assert.Equal(0, second.Frames);
        Assert.Equal(0, second.DrawMsAvg);
        Assert.Equal(0, second.DrawMsMax);
        // O estado instantâneo NÃO zera: a câmera continua onde o último frame
        // a deixou, e reportá-la em (0,0) seria inventar um salto.
        Assert.Equal(11f, second.CameraX);
        Assert.Equal(40, second.Quads);
    }

    [Fact]
    public void O_payload_separa_o_que_o_frame_desenhou_do_que_a_cena_contem()
    {
        var service = new EngineService();
        service.Lights.Add(new LightData(
            LightType.Point,
            Position: new Vector2(1, 2),
            Height: 0f,
            Direction: Vector2.UnitX,
            Color: new Vector3(1, 1, 1),
            Intensity: 1f,
            Radius: 10f,
            InnerConeCos: 1f,
            OuterConeCos: 0f));
        var probe = new FrameTelemetryProbe();
        probe.Record(MsToTicks(4), 64f, 32f, 1f, quads: 12, quadsRequired: 99, truncated: true);
        Assert.True(probe.TryTake(out var sample));

        var json = JsonSerializer.SerializeToElement(
            FrameTelemetryPublisher.BuildParams(in sample, service));

        Assert.Equal(1, json.GetProperty("frames").GetInt32());
        Assert.Equal(64, json.GetProperty("camera").GetProperty("x").GetDouble());
        Assert.Equal(12, json.GetProperty("frame").GetProperty("quads").GetInt32());
        Assert.Equal(99, json.GetProperty("frame").GetProperty("quadsRequired").GetInt32());
        Assert.True(json.GetProperty("frame").GetProperty("truncated").GetBoolean());

        // A luz existe na CENA e não é desenhada pela onda A. Somá-la ao que o
        // frame desenhou faria a telemetria afirmar uma imagem que a janela
        // não mostra; por isso são dois grupos, não um total.
        Assert.Equal(1, json.GetProperty("scene").GetProperty("lights").GetInt32());
        Assert.Equal(0, json.GetProperty("scene").GetProperty("actors").GetInt32());
    }

    [Fact]
    public void Gravar_a_telemetria_do_frame_e_livre_de_alocacao()
    {
        // A telemetria é chamada DENTRO do Draw, a 60 Hz. Se medir custasse
        // lixo, ela seria a única alocação por frame do host — e a política
        // Zero-GC teria sido quebrada justamente pelo instrumento que existe
        // para observá-la.
        var probe = new FrameTelemetryProbe();
        var allocated = AllocationProbe.MinimumAllocatedBytes(() =>
        {
            for (var i = 0; i < 1_000; i++)
            {
                probe.Record(1234, 10f, 20f, 1f, quads: 30, quadsRequired: 30, truncated: false);
            }
        });

        Assert.Equal(0, allocated);
    }

    [Fact]
    public void O_metodo_do_fio_e_uma_notificacao_com_nome_estavel()
    {
        // O nome viaja em contracts/schemas/frame.telemetry.schema.json e no
        // middleware; trocá-lo aqui sem trocar lá quebra o fio em silêncio.
        Assert.Equal("frame/telemetry", FrameTelemetryPublisher.Method);
        Assert.Equal(TimeSpan.FromSeconds(1), FrameTelemetryPublisher.Interval);
    }
}
