using System.Reflection;
using Gridsmith.Engine.Core.Rigging;
using Gridsmith.Engine.Graphics;
using Gridsmith.Engine.Host;
using Gridsmith.Engine.Ipc.Protocol;
using Gridsmith.Engine.Runtime;
using Xunit;

namespace Gridsmith.Engine.Ipc.Tests;

/// <summary>
/// TESTES ARQUITETURAIS da engine (fitness functions) — docs/GOVERNANCE.md.
/// As fronteiras entre camadas são asserções sobre as referências REAIS dos
/// assemblies: violar a governança quebra o CI, não uma revisão de código.
/// </summary>
public class ArchitectureTests
{
    private static string[] GridsmithReferencesOf(Assembly assembly) =>
        assembly.GetReferencedAssemblies()
            .Select(a => a.Name ?? "")
            .Where(name => name.StartsWith("Gridsmith.", StringComparison.Ordinal))
            .OrderBy(name => name)
            .ToArray();

    [Fact]
    public void E1_Core_nao_depende_de_nenhuma_outra_camada_Gridsmith()
    {
        // O núcleo DOD é a base: portável para qualquer host, sem IPC/gráficos.
        var core = typeof(SkeletonStore).Assembly;
        Assert.Empty(GridsmithReferencesOf(core));
    }

    [Fact]
    public void E2_Ipc_e_um_plano_de_controle_independente_do_dominio()
    {
        // O peer JSON-RPC não conhece o domínio: qualquer serviço pode usá-lo.
        var ipc = typeof(FrameCodec).Assembly;
        Assert.Empty(GridsmithReferencesOf(ipc));
    }

    [Fact]
    public void E3_Graphics_so_conhece_o_Core()
    {
        // A camada MonoGame consome os stores DOD; nunca o IPC nem o Runtime.
        var graphics = typeof(DeferredRenderer).Assembly;
        Assert.Equal(new[] { "Gridsmith.Engine.Core" }, GridsmithReferencesOf(graphics));
    }

    [Fact]
    public void E4_Runtime_orquestra_Core_e_Ipc_mas_nao_Graphics()
    {
        // O serviço headless não arrasta dependências gráficas (SDL/OpenGL):
        // o host MonoGame acopla por fora, nunca o contrário.
        var runtime = typeof(EngineService).Assembly;
        Assert.Equal(new[] { "Gridsmith.Engine.Core", "Gridsmith.Engine.Ipc" }, GridsmithReferencesOf(runtime));
    }

    private static bool ReferencesMonoGame(Assembly assembly) =>
        assembly.GetReferencedAssemblies()
            .Any(a => (a.Name ?? "").Contains("MonoGame", StringComparison.OrdinalIgnoreCase));

    [Fact]
    public void E6_so_o_Host_junta_MonoGame_com_o_plano_de_controle()
    {
        // O host gráfico é COMPOSIÇÃO (ADR-022): é o único ponto onde MonoGame
        // encontra o plano de controle. Se o Runtime passar a arrastar
        // MonoGame, ele deixa de subir sem GPU — e as fases 1–4 e os
        // transports saem do CI junto, que é o que a regra E4 protege.
        var host = typeof(GridsmithGame).Assembly;
        Assert.True(ReferencesMonoGame(host), "o host gráfico precisa de MonoGame");
        Assert.Equal(
            new[] { "Gridsmith.Engine.Core", "Gridsmith.Engine.Ipc", "Gridsmith.Engine.Runtime" },
            GridsmithReferencesOf(host));

        // A telemetria de frame nasce no MESMO ponto (ADR-023): quem publica
        // números sobre frames é quem TEM frames. Mover o publisher para o Ipc
        // ou para o Runtime "para reaproveitar" abriria a porta para o serviço
        // headless anunciar desempenho de um desenho que ele nunca fez — e o
        // Runtime não pode nem referenciar o Host (a referência é a inversa),
        // então esta asserção é o que impede o caminho de volta.
        Assert.Equal("Gridsmith.Engine.Host", typeof(FrameTelemetryPublisher).Assembly.GetName().Name);
        Assert.Equal("Gridsmith.Engine.Host", typeof(FrameTelemetryProbe).Assembly.GetName().Name);

        // Graphics também vê MonoGame — é a camada de desenho —, mas não vê o
        // plano de controle (E3). Fora esses dois, ninguém em produção vê.
        Assert.True(ReferencesMonoGame(typeof(DeferredRenderer).Assembly));
        foreach (var assembly in new[]
                 {
                     typeof(SkeletonStore).Assembly,
                     typeof(FrameCodec).Assembly,
                     typeof(EngineService).Assembly,
                 })
        {
            Assert.False(
                ReferencesMonoGame(assembly),
                $"{assembly.GetName().Name} não pode arrastar MonoGame");
        }
    }

    [Fact]
    public void E5_Core_nao_referencia_MonoGame()
    {
        // Zero-GC e DOD não podem depender de tipos do framework gráfico.
        var core = typeof(SkeletonStore).Assembly;
        var monoGameRefs = core.GetReferencedAssemblies()
            .Where(a => (a.Name ?? "").Contains("MonoGame", StringComparison.OrdinalIgnoreCase));
        Assert.Empty(monoGameRefs);
    }
}
