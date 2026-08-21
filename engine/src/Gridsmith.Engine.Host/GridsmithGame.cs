using System.Diagnostics;
using Gridsmith.Engine.Core.Level;
using Gridsmith.Engine.Core.Rendering;
using Gridsmith.Engine.Runtime;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;

namespace Gridsmith.Engine.Host;

/// <summary>
/// A janela do Gridsmith: desenha, por referência, os MESMOS stores DOD que o
/// plano de controle JSON-RPC muta. Nada é copiado entre as duas coisas — o
/// <see cref="EngineService"/> é o dono, e o loop de desenho apenas lê.
///
/// <para>Esta classe é <b>executora</b>, não decisora: o que compõe o frame é
/// o <see cref="FrameComposer"/>, puro e testável sem GPU (ADR-022). Aqui só
/// existe a tradução de quads em chamadas de desenho.</para>
///
/// <para><b>Onda A desenha com <see cref="SpriteBatch"/></b>, cujo efeito é
/// embutido no MonoGame e não passa pelo MGCB. Não é degradação condicional —
/// é o único caminho desta onda, porque ainda não existe atlas: `tileset/define`
/// e o <c>DeferredRenderer</c> entram na onda que traz a arte. Um host que
/// caísse para cor chapada só QUANDO o atlas faltasse criaria dois caminhos, e
/// o teste de paridade passaria a comparar o degradado.</para>
/// </summary>
public sealed class GridsmithGame : Game
{
    /// <summary>
    /// Teto de quads por frame. Fixo e pré-alocado: o buffer é o do chamador,
    /// e a política Zero-GC proíbe crescer no meio do desenho. Um frame que
    /// estoure sai TRUNCADO e reportado, nunca alocando.
    /// </summary>
    private const int MaxQuadsPerFrame = 16_384;

    private readonly GraphicsDeviceManager _graphics;
    private readonly EngineService _service;
    private readonly string _contentRoot;
    private readonly FrameTelemetryProbe? _telemetry;
    private readonly FrameQuad[] _quads = new FrameQuad[MaxQuadsPerFrame];

    /// <summary>
    /// Texturas por caminho de imagem. `null` registrado = carga já falhou;
    /// sem a entrada negativa o host tentaria reabrir o arquivo TODO frame.
    /// </summary>
    private readonly Dictionary<string, Texture2D?> _atlasTextures = new(StringComparer.Ordinal);

    private SpriteBatch? _batch;
    private Texture2D? _pixel;
    private int _lastTruncatedRequired;

    /// <param name="telemetry">
    /// Acumulador da telemetria de frame; <c>null</c> desliga a medição. É
    /// opcional porque desenhar não pode depender de haver observador — o host
    /// abre a janela igual, com ou sem middleware do outro lado.
    /// </param>
    public GridsmithGame(
        EngineService service,
        string? contentRoot = null,
        FrameTelemetryProbe? telemetry = null)
    {
        _service = service;
        _contentRoot = contentRoot ?? Environment.CurrentDirectory;
        _telemetry = telemetry;
        _graphics = new GraphicsDeviceManager(this)
        {
            PreferredBackBufferWidth = 1280,
            PreferredBackBufferHeight = 720,
        };
        Content.RootDirectory = "Content";
        IsMouseVisible = true;
        Window.Title = "Gridsmith — runtime";
    }

    protected override void LoadContent()
    {
        _batch = new SpriteBatch(GraphicsDevice);
        // Textura de 1×1 branca: é o que permite desenhar quads coloridos sem
        // nenhum asset e sem content pipeline. Vira a amostragem do atlas na
        // onda seguinte.
        _pixel = new Texture2D(GraphicsDevice, 1, 1);
        _pixel.SetData([Color.White]);
        base.LoadContent();
    }

    protected override void Draw(GameTime gameTime)
    {
        // Relógio de parede em vez de gameTime.ElapsedGameTime: com
        // IsFixedTimeStep (default do MonoGame) o tempo do GameTime é o passo
        // NOMINAL, sempre 16,67 ms — reportá-lo como desempenho seria publicar
        // uma constante disfarçada de medição.
        var startedAt = Stopwatch.GetTimestamp();

        GraphicsDevice.Clear(new Color(16, 18, 22));
        if (_batch is null || _pixel is null)
        {
            return;
        }

        var viewport = CurrentViewport();
        // O host NÃO conduz a câmera: quem a move é o plano de controle
        // (camera/configure, camera/simulate). Amortecer aqui faria dois donos
        // disputarem a mesma posição, e a imagem discordaria do documento.
        var composition = FrameComposer.Compose(
            _service.Tilemaps,
            FirstTilemap(),
            _service.Actors,
            viewport,
            actorSize: 16f,
            _quads);

        // Truncar em silêncio desenharia meio nível e pareceria bug de
        // conteúdo; o aviso sai uma vez por mudança, não por frame.
        if (composition.Truncated && composition.Required != _lastTruncatedRequired)
        {
            _lastTruncatedRequired = composition.Required;
            Console.Error.WriteLine(
                $"[host] frame truncado: {composition.Required} quads visíveis, {MaxQuadsPerFrame} desenháveis");
        }
        else if (!composition.Truncated)
        {
            _lastTruncatedRequired = 0;
        }

        var scale = viewport.Zoom;
        var originX = viewport.CenterX - viewport.HalfWorldWidth;
        var originY = viewport.CenterY - viewport.HalfWorldHeight;

        // A tabela do mapa desenhado, resolvida UMA vez por frame: o vínculo
        // vem do tilemap (tilesetId por slot), a tabela do registro da sessão
        // e a textura do cache — sem alocação no caminho.
        var map = FirstTilemap();
        TilesetTable atlasTable = default;
        var hasTable = map.IsValid
            && _service.Tilemaps.TilesetId(map) is { } tilesetId
            && _service.Tilesets.TryGet(tilesetId, out atlasTable);
        var atlasTexture = hasTable ? TextureFor(atlasTable.Image) : null;

        _batch.Begin(samplerState: SamplerState.PointClamp);
        for (var i = 0; i < composition.Written; i++)
        {
            ref readonly var quad = ref _quads[i];
            var destination = new Rectangle(
                (int)MathF.Round((quad.X - originX) * scale),
                (int)MathF.Round((quad.Y - originY) * scale),
                Math.Max(1, (int)MathF.Round(quad.Width * scale)),
                Math.Max(1, (int)MathF.Round(quad.Height * scale)));

            // Amostra o atlas SÓ quando a tabela cobre o tile; qualquer outra
            // situação (sem tileset, imagem ausente, id fora da faixa) cai na
            // MESMA cor determinística do editor — os dois lados degradam
            // juntos, nunca um fingindo o que o outro não mostra.
            if (quad.Layer == FrameLayer.Tilemap
                && atlasTexture is not null
                && atlasTable.TryRegion(quad.TileId, out var sourceX, out var sourceY))
            {
                _batch.Draw(
                    atlasTexture,
                    destination,
                    new Rectangle(sourceX, sourceY, atlasTable.TileSize, atlasTable.TileSize),
                    Color.White);
            }
            else
            {
                _batch.Draw(_pixel, destination, ColorOf(in quad));
            }
        }

        _batch.End();
        base.Draw(gameTime);

        // Depois do End(): o que se mede é o frame inteiro, incluindo o
        // flush do batch. Medir só o laço de Draw contaria o barato e
        // esconderia o caro.
        _telemetry?.Record(
            Stopwatch.GetTimestamp() - startedAt,
            viewport.CenterX,
            viewport.CenterY,
            viewport.Zoom,
            composition.Written,
            composition.Required,
            composition.Truncated);
    }

    private FrameViewport CurrentViewport()
    {
        var camera = _service.Camera;
        var position = camera.Position + camera.ShakeOffset;
        return new FrameViewport(
            position.X,
            position.Y,
            GraphicsDevice.Viewport.Width,
            GraphicsDevice.Viewport.Height,
            Zoom: 1f);
    }

    /// <summary>
    /// Primeiro tilemap vivo. A escolha de QUAL nível desenhar é do documento
    /// (world map), não do host; enquanto o comando não existe, desenhar o
    /// primeiro é honesto — e ficar sem desenhar nada seria pior.
    /// </summary>
    private TilemapHandle FirstTilemap()
    {
        for (var slot = 0; slot < _service.Tilemaps.Capacity; slot++)
        {
            var handle = new TilemapHandle(slot);
            if (_service.Tilemaps.Width(handle) > 0)
            {
                return handle;
            }
        }

        return TilemapHandle.Invalid;
    }

    /// <summary>
    /// Cor provisória por <c>tileId</c>, determinística. Some quando o atlas
    /// entrar: aí a cor vira amostragem de textura, nos dois lados do fio.
    /// </summary>
    private static Color ColorOf(in FrameQuad quad)
    {
        if (quad.Layer == FrameLayer.Actor)
        {
            return new Color(58, 160, 240);
        }

        // hash determinístico do tileId — a mesma entrada dá sempre a mesma cor
        var hash = (uint)quad.TileId * 2654435761u;
        return new Color(
            (int)(80 + (hash & 0x7F)),
            (int)(80 + ((hash >> 8) & 0x7F)),
            (int)(80 + ((hash >> 16) & 0x7F)));
    }

    /// <summary>
    /// Textura do atlas por referência de imagem, com cache NEGATIVO: uma
    /// imagem que não carrega é registrada como null e reportada uma vez —
    /// sem isso o host tentaria reabrir o arquivo a cada frame.
    /// </summary>
    private Texture2D? TextureFor(string imageReference)
    {
        if (_atlasTextures.TryGetValue(imageReference, out var cached))
        {
            return cached;
        }

        Texture2D? texture = null;
        var fullPath = Path.IsPathRooted(imageReference)
            ? imageReference
            : Path.Combine(_contentRoot, imageReference);
        try
        {
            using var stream = File.OpenRead(fullPath);
            texture = Texture2D.FromStream(GraphicsDevice, stream);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(
                $"[host] atlas \"{imageReference}\" não carregou ({ex.Message}); tiles em cor determinística");
        }

        _atlasTextures[imageReference] = texture;
        return texture;
    }

    protected override void UnloadContent()
    {
        foreach (var texture in _atlasTextures.Values)
        {
            texture?.Dispose();
        }

        _atlasTextures.Clear();
        _pixel?.Dispose();
        _batch?.Dispose();
        base.UnloadContent();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _graphics.Dispose();
        }

        base.Dispose(disposing);
    }
}
