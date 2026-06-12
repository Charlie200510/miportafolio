# ============================================================
#  DESCARGADOR DEL UNIVERSO (10,000+ tickers globales)
# ============================================================
#  Combina:
#    - Russell 3000 + S&P 500/400/600 + NASDAQ-100 (~3-9K acciones US)
#    - NASDAQ Trader full listing (todas las acciones US listadas)
#    - BMV / IPC México (~150 emisoras)
#    - 200+ criptomonedas (top por market cap)
#    - ETFs líderes (~120)
#    - ADRs y blue chips europeas/asiáticas/latinoamericanas (~400)
#
#  Filtros automáticos:
#    - Historia ≥ 126 días (~6 meses)
#    - Última cotización ≤ 7 días hábiles (drop delisted)
#
#  Salidas:
#    universo_precios.csv   ← precios de cierre diarios
#    universo_info.json     ← metadata por ticker
#
#  La descarga se hace en chunks de 200 para no saturar yfinance.
#  Tiempo total: 15-30 min según conexión.
# ============================================================
from __future__ import annotations

import io
import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, timedelta
from pathlib import Path
from typing import List

import pandas as pd
import requests
import yfinance as yf

# ============================================================
# 1. LISTAS RECOMENDADAS (destacadas en UI con ⭐)
# ============================================================
SP500_RECOMENDADAS = [
    "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "BRK-B", "AVGO",
    "TSLA", "JPM", "V", "WMT", "UNH", "XOM", "MA", "PG", "JNJ", "COST",
    "HD", "ORCL", "MRK", "ABBV", "BAC", "CVX", "KO", "PEP", "AMD",
    "ADBE", "NFLX", "CSCO",
]
IPC_RECOMENDADAS = [
    "WALMEX.MX", "FEMSAUBD.MX", "GFNORTEO.MX", "GMEXICOB.MX",
    "CEMEXCPO.MX", "BIMBOA.MX", "KOFUBL.MX", "GAPB.MX", "ASURB.MX",
    "ORBIA.MX", "AMXB.MX", "ELEKTRA.MX", "ALSEA.MX", "GRUMAB.MX",
    "PINFRA.MX", "MEGACPO.MX", "OMAB.MX", "AC.MX",
]

# ============================================================
# 2. ETFs e ÍNDICES (todos recomendados — saltan arriba en UI)
# ============================================================
ETFS_INDICES = [
    # Índices US
    "SPY", "VOO", "IVV", "QQQ", "DIA", "IWM", "VTI", "VTV", "VUG", "VEA", "VWO",
    "MDY", "IJH", "IJR", "ITOT", "SCHB", "SCHD", "SCHX", "SCHG", "SCHF",
    # Sectoriales
    "XLK", "XLF", "XLV", "XLE", "XLY", "XLP", "XLI", "XLU", "XLB", "XLRE", "XLC",
    "VGT", "VHT", "VFH", "VDE", "VPU", "VAW", "VIS", "VNQ", "VOX", "VCR", "VDC",
    # Emergentes y desarrollados
    "EEM", "IEMG", "EFA", "IEFA", "VEU", "ACWI", "EWJ", "EWZ", "EWG", "EWU",
    "INDA", "MCHI", "FXI", "ASHR", "EWY", "EWT", "EWQ", "EWP", "EWI",
    # Bonos
    "AGG", "BND", "TLT", "IEF", "SHY", "LQD", "HYG", "JNK", "MUB", "TIP", "BSV",
    # Commodities
    "GLD", "SLV", "USO", "UNG", "DBC", "GDX", "GDXJ", "PPLT", "PALL",
    # Crypto
    "BITO", "FBTC", "IBIT", "ARKB", "GBTC",
    # Tematicos
    "ARKK", "ARKW", "ARKG", "ARKF", "ARKQ", "ARKX", "PRNT", "ICLN", "TAN",
    "LIT", "URA", "ROBO", "BOTZ", "SOXX", "SMH", "FDN", "HACK", "CIBR",
    # MX
    "NAFTRAC.MX", "MEXTRAC.MX",
]
ETFS_INDICES = sorted(set(ETFS_INDICES))

# ============================================================
# 3. CRIPTOMONEDAS — TOP 200 por market cap
# ============================================================
CRYPTO_TICKERS = [
    # Top 30 (más liquidez)
    "BTC-USD", "ETH-USD", "USDT-USD", "BNB-USD", "SOL-USD", "USDC-USD", "XRP-USD",
    "DOGE-USD", "TRX-USD", "TON11419-USD", "ADA-USD", "AVAX-USD", "SHIB-USD",
    "WBTC-USD", "DOT-USD", "LINK-USD", "BCH-USD", "NEAR-USD", "MATIC-USD",
    "LTC-USD", "DAI-USD", "UNI7083-USD", "PEPE24478-USD", "ICP-USD", "LEO-USD",
    "ETC-USD", "APT21794-USD", "HBAR-USD", "STX4847-USD", "RNDR-USD",
    # 30-100
    "FIL-USD", "ARB11841-USD", "VET-USD", "ATOM-USD", "MNT27075-USD", "OP-USD",
    "MKR-USD", "INJ-USD", "GRT6719-USD", "IMX10603-USD", "TIA22861-USD",
    "AAVE-USD", "WLD-USD", "ALGO-USD", "EGLD-USD", "FTM-USD", "QNT-USD",
    "FLOW-USD", "SAND-USD", "AXS-USD", "MANA-USD", "EOS-USD", "XLM-USD",
    "RUNE-USD", "THETA-USD", "XTZ-USD", "CHZ-USD", "ZEC-USD", "DASH-USD",
    "MINA-USD", "GALA-USD", "FET-USD", "AGIX-USD", "OCEAN-USD", "RPL-USD",
    "PENDLE-USD", "ENS-USD", "1INCH-USD", "BAT-USD", "ENJ-USD", "BLUR-USD",
    "WAVES-USD", "ZIL-USD", "ROSE-USD", "DYDX-USD", "GMX-USD", "SUSHI-USD",
    "COMP-USD", "SNX-USD", "CRV-USD", "BAL-USD", "YFI-USD", "UMA-USD",
    "KSM-USD", "ICX-USD", "SC-USD", "QTUM-USD", "ZRX-USD", "OMG-USD",
    "NANO-USD", "CELO-USD", "ANKR-USD", "STORJ-USD", "RVN-USD", "BAND-USD",
    "KAVA-USD", "LRC-USD", "IOTX-USD", "AUDIO-USD", "GLM-USD", "MASK-USD",
    # 100-200 (lower cap pero con historia)
    "WAXP-USD", "API3-USD", "SXP-USD", "PERP-USD", "FXS-USD", "CTSI-USD",
    "REN-USD", "BNT-USD", "REQ-USD", "MTL-USD", "AKRO-USD", "OXT-USD",
    "REP-USD", "KEEP-USD", "NU-USD", "TFUEL-USD", "VTHO-USD", "ONT-USD",
    "ONG-USD", "CKB-USD", "HNT-USD", "ANT-USD", "MLN-USD", "LPT-USD",
    "SKL-USD", "BAKE-USD", "BURGER-USD", "ALPHA-USD", "BEL-USD", "RIF-USD",
    "RLC-USD", "OGN-USD", "DGB-USD", "MIR-USD", "DODO-USD", "FRONT-USD",
    "JST-USD", "HARD-USD", "WIN-USD", "SUN-USD", "BTT-USD", "WRX-USD",
    "TRB-USD", "AKT-USD", "UFT-USD", "RARE-USD", "CHESS-USD", "FORTH-USD",
    "ALPACA-USD", "QUICK-USD", "DEXE-USD", "DAR-USD", "MOVR-USD", "CLV-USD",
    "FARM-USD", "BADGER-USD", "POND-USD", "VOXEL-USD", "MBOX-USD", "BICO-USD",
    "JASMY-USD", "PYR-USD", "BNX-USD", "GHST-USD", "LUSD-USD", "GMT18069-USD",
    "APE18876-USD", "GST20582-USD", "LDO-USD", "FXS-USD", "FLR-USD", "JOE-USD",
    "RDNT-USD", "ID18762-USD", "MAGIC-USD", "JTO-USD", "WIF-USD", "BONK-USD",
    "FLOKI-USD", "MEME-USD", "BOME-USD", "PYTH-USD", "PIXEL-USD", "PORTAL-USD",
    "STRK22691-USD", "AEVO-USD", "ONDO-USD", "ETHFI-USD", "W-USD", "ZK-USD",
    "IO-USD",
]
# Mucho duplicado posible; deduplicamos
CRYPTO_TICKERS = sorted(set(CRYPTO_TICKERS))
CRYPTO_RECOMENDADAS = ["BTC-USD", "ETH-USD", "SOL-USD", "BNB-USD", "XRP-USD",
                       "DOGE-USD", "ADA-USD", "AVAX-USD", "MATIC-USD", "LINK-USD"]

# ============================================================
# 4. INTERNACIONAL — blue chips europeas, asiáticas, latam
# ============================================================
INTERNACIONALES = [
    # FTSE 100 (UK) - top
    "SHEL.L", "AZN.L", "HSBA.L", "ULVR.L", "BP.L", "GSK.L", "DGE.L", "RIO.L",
    "BATS.L", "LSEG.L", "NG.L", "REL.L", "PRU.L", "BARC.L", "LLOY.L", "VOD.L",
    "TSCO.L", "GLEN.L", "AAL.L", "BT-A.L",
    # DAX (Alemania)
    "SAP.DE", "SIE.DE", "ALV.DE", "MUV2.DE", "DTE.DE", "ADS.DE", "BAS.DE",
    "BMW.DE", "DBK.DE", "DB1.DE", "BAYN.DE", "CON.DE", "MBG.DE", "VOW3.DE",
    "RWE.DE", "ENR.DE", "FRE.DE", "HEN3.DE", "BEI.DE",
    # CAC 40 (Francia)
    "MC.PA", "OR.PA", "AIR.PA", "TTE.PA", "SAN.PA", "BNP.PA", "RMS.PA",
    "AI.PA", "EL.PA", "SU.PA", "DG.PA", "VIE.PA", "ENGI.PA", "ORA.PA",
    # IBEX 35 (España)
    "ITX.MC", "IBE.MC", "SAN.MC", "BBVA.MC", "TEF.MC", "REP.MC", "AENA.MC",
    "FER.MC", "AMS.MC", "CABK.MC", "GRF.MC", "ELE.MC",
    # FTSEMIB (Italia)
    "ENI.MI", "ENEL.MI", "STLA.MI", "RACE.MI", "ISP.MI", "UCG.MI", "G.MI",
    "FCA.MI", "TIT.MI",
    # SMI (Suiza)
    "NESN.SW", "ROG.SW", "NOVN.SW", "UBSG.SW", "ZURN.SW", "ABBN.SW", "CSGN.SW",
    "GIVN.SW", "LONN.SW",
    # AEX (Holanda)
    "ASML.AS", "RDSA.AS", "UNA.AS", "PHIA.AS", "INGA.AS", "AD.AS", "HEIA.AS",
    "DSM.AS", "WKL.AS",
    # OMX (Nórdicos)
    "NOVO-B.CO", "DSV.CO", "MAERSK-B.CO", "ORSTED.CO", "VWS.CO",
    "VOLV-B.ST", "ATCO-A.ST", "SEB-A.ST", "ERIC-B.ST", "HM-B.ST",
    "EQNR.OL", "DNB.OL", "NHY.OL", "TEL.OL", "MOWI.OL",
    # Japón (Nikkei top, sufijo .T)
    "7203.T", "6758.T", "6861.T", "9984.T", "8058.T", "8306.T", "9433.T",
    "7974.T", "6098.T", "8035.T", "6501.T", "6594.T", "6920.T", "9432.T",
    "6273.T", "4063.T", "8031.T", "6301.T", "7267.T", "8001.T",
    # China/Hong Kong (.HK)
    "0700.HK", "9988.HK", "3690.HK", "1299.HK", "2318.HK", "0939.HK", "1398.HK",
    "0388.HK", "0005.HK", "0027.HK", "0883.HK", "0857.HK", "0386.HK",
    "1810.HK", "1024.HK", "9618.HK", "9999.HK",
    # India (.NS — National Stock Exchange)
    "RELIANCE.NS", "TCS.NS", "HDFCBANK.NS", "INFY.NS", "ICICIBANK.NS",
    "HINDUNILVR.NS", "BHARTIARTL.NS", "SBIN.NS", "ITC.NS", "BAJFINANCE.NS",
    "ASIANPAINT.NS", "LT.NS", "AXISBANK.NS", "WIPRO.NS", "MARUTI.NS",
    "HCLTECH.NS", "TITAN.NS", "ULTRACEMCO.NS", "ADANIENT.NS",
    # Corea (.KS)
    "005930.KS", "000660.KS", "035420.KS", "005380.KS", "035720.KS",
    "207940.KS", "051910.KS", "012330.KS", "068270.KS",
    # Taiwán (.TW)
    "2330.TW", "2454.TW", "2317.TW", "2412.TW", "2308.TW",
    # Australia (.AX)
    "BHP.AX", "CBA.AX", "CSL.AX", "NAB.AX", "WBC.AX", "ANZ.AX", "WES.AX",
    "WOW.AX", "TLS.AX", "RIO.AX", "MQG.AX", "FMG.AX",
    # Brasil (.SA)
    "PETR4.SA", "VALE3.SA", "ITUB4.SA", "BBDC4.SA", "B3SA3.SA", "ABEV3.SA",
    "WEGE3.SA", "SUZB3.SA", "MGLU3.SA", "JBSS3.SA", "BRFS3.SA", "ELET3.SA",
    "RENT3.SA", "RADL3.SA", "EGIE3.SA",
    # ADRs (US-listed, fáciles de comprar)
    "TSM", "BABA", "JD", "PDD", "BIDU", "NIO", "LI", "XPEV", "BILI",
    "MELI", "VALE", "PBR", "ITUB", "BBD", "SHOP", "RY", "TD", "CNI", "CP",
    "NVO", "SAP", "TM", "SONY", "HMC", "MUFG", "SMFG", "STM", "TEVA",
    "TEFL", "CHL", "ASML", "NESN.SW",
]
INTERNACIONALES = sorted(set(INTERNACIONALES))

# ============================================================
# 5. IPC México COMPLETO + adicionales BMV
# ============================================================
BMV_COMPLETO = [
    # IPC 35
    "AC.MX", "ALFAA.MX", "ALSEA.MX", "AMXB.MX", "ASURB.MX",
    "BBAJIOO.MX", "BIMBOA.MX", "BOLSAA.MX", "CEMEXCPO.MX", "CHDRAUIB.MX",
    "CUERVO.MX", "ELEKTRA.MX", "FEMSAUBD.MX", "GAPB.MX", "GCARSOA1.MX",
    "GCC.MX", "GENTERA.MX", "GFINBURO.MX", "GFNORTEO.MX", "GMEXICOB.MX",
    "GRUMAB.MX", "KIMBERA.MX", "KOFUBL.MX", "LABB.MX", "LIVEPOLC-1.MX",
    "MEGACPO.MX", "OMAB.MX", "ORBIA.MX", "PE&OLES.MX", "PINFRA.MX",
    "Q.MX", "RA.MX", "TLEVISACPO.MX", "VESTA.MX", "WALMEX.MX",
    # FIBRAS
    "FUNO11.MX", "FIBRAMQ12.MX", "FIBRAPL14.MX", "FIBRAHD15.MX",
    "FMTY14.MX", "FIHO12.MX", "TERRA13.MX", "DANHOS13.MX", "FNOVA17.MX",
    "STORAGE18.MX", "FCFE18.MX",
    # Otras BMV con liquidez
    "SORIANAB.MX", "FRAGUAB.MX", "BSMXB.MX", "CYDSASAA.MX", "VITROA.MX",
    "ALPEKA.MX", "ARA.MX", "GFAMSAA.MX", "GISSAA.MX", "GMD.MX",
    "GPHB.MX", "GPROFUT.MX", "GSANBORB-1.MX", "HCITY.MX", "HERDEZ.MX",
    "HOGAR-B.MX", "ICA.MX", "ICHB.MX", "IDEALB-1.MX", "INVEXA.MX",
    "LAMOSA.MX", "MAXCOMA.MX", "MEDICAB.MX", "MFRISCOA-1.MX",
    "MINSAB.MX", "MONEXB.MX", "NEMAKA.MX", "NMKA.MX", "POCHTECB.MX",
    "POSADASA.MX", "PROCORB.MX", "PV.MX", "RCENTROA.MX", "SARE.MX",
    "SIMECB.MX", "SITESB-1.MX", "SPORTS.MX", "TMMA.MX", "TVAZTCPO.MX",
    "URBI.MX", "VINTE.MX", "VITRO.MX", "VOLARA.MX",
]
BMV_COMPLETO = sorted(set(BMV_COMPLETO))

# Fallback mínimo si no hay internet
SP500_FALLBACK = SP500_RECOMENDADAS

# ============================================================
# 6. CONFIG DE DESCARGA
# ============================================================
DIAS_HISTORIA = 730
MIN_DIAS = 126            # ~6 meses de historia
MAX_DIAS_SIN_COTIZAR = 7  # último precio debe ser ≤ 7 días atrás
CHUNK_SIZE = 200          # tickers por llamada yfinance.download
PAUSA_ENTRE_CHUNKS = 1.0  # segundos


# ============================================================
# 7. SCRAPERS — listas dinámicas
# ============================================================
def _scrape_wiki_table(url: str, col: str = "Symbol") -> List[str]:
    try:
        tablas = pd.read_html(url, storage_options={"User-Agent": "Mozilla/5.0"})
        for t in tablas:
            if col in t.columns:
                syms = t[col].astype(str).tolist()
                return [s.replace(".", "-").strip() for s in syms if s and s != "nan"]
    except Exception as e:
        print(f"  scrape {url} falló: {e}")
    return []


def obtener_sp500() -> List[str]:
    print("Descargando S&P 500…")
    syms = _scrape_wiki_table("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies")
    print(f"  → {len(syms)} tickers" if syms else "  → fallback")
    return syms or list(SP500_FALLBACK)


def obtener_sp400_midcap() -> List[str]:
    print("Descargando S&P 400 MidCap…")
    syms = _scrape_wiki_table("https://en.wikipedia.org/wiki/List_of_S%26P_400_companies")
    print(f"  → {len(syms)} tickers")
    return syms


def obtener_sp600_smallcap() -> List[str]:
    print("Descargando S&P 600 SmallCap…")
    syms = _scrape_wiki_table("https://en.wikipedia.org/wiki/List_of_S%26P_600_companies")
    print(f"  → {len(syms)} tickers")
    return syms


def obtener_nasdaq100() -> List[str]:
    print("Descargando NASDAQ-100…")
    syms = _scrape_wiki_table("https://en.wikipedia.org/wiki/Nasdaq-100", col="Ticker")
    print(f"  → {len(syms)} tickers")
    return syms


def obtener_dow_jones() -> List[str]:
    print("Descargando Dow Jones…")
    syms = _scrape_wiki_table("https://en.wikipedia.org/wiki/Dow_Jones_Industrial_Average")
    print(f"  → {len(syms)} tickers")
    return syms


def obtener_russell1000() -> List[str]:
    print("Descargando Russell 1000…")
    syms = _scrape_wiki_table("https://en.wikipedia.org/wiki/Russell_1000_Index", col="Ticker")
    print(f"  → {len(syms)} tickers")
    return syms


def obtener_nasdaqtrader_full() -> List[str]:
    """Lista completa de TODAS las acciones US listadas (~9-10K).

    Fuente oficial: archivo plano de NASDAQ Trader, separado por |.
    Filtra ETFs duplicados, test issues y tickers con caracteres raros.
    """
    print("Descargando lista completa NASDAQ Trader (~9K tickers)…")
    URLS = [
        "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqtraded.txt",
        "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt",
        "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt",
    ]
    out: List[str] = []
    for url in URLS:
        try:
            r = requests.get(url, timeout=30, headers={"User-Agent": "Mozilla/5.0"})
            if r.status_code != 200:
                continue
            df = pd.read_csv(io.StringIO(r.text), sep="|")
            # Última fila suele ser un footer "File Creation Time"
            if "Symbol" in df.columns:
                col = "Symbol"
            elif "ACT Symbol" in df.columns:
                col = "ACT Symbol"
            else:
                continue
            # Filtrar test issues y entries vacíos
            df = df[df.get("Test Issue", "N").astype(str).str.upper() != "Y"]
            syms = df[col].dropna().astype(str).tolist()
            # Limpieza: dropear si tiene $, ., espacios o no es alfanumérico+guion
            limpios = []
            for s in syms:
                s = s.strip()
                if not s or len(s) > 8:
                    continue
                if any(c in s for c in ["$", " ", ".", "/"]):
                    continue
                limpios.append(s.upper())
            out.extend(limpios)
        except Exception as e:
            print(f"  warn: no se pudo bajar {url.split('/')[-1]}: {e}")
    out = sorted(set(out))
    print(f"  → {len(out)} tickers US totales")
    return out


# ============================================================
# 8. DESCARGA DE PRECIOS — en chunks
# ============================================================
def descargar_precios_chunk(tickers: List[str], dias=DIAS_HISTORIA) -> pd.DataFrame:
    """Descarga precios para una lista de tickers (sin chunking interno)."""
    fecha_fin = date.today()
    fecha_ini = fecha_fin - timedelta(days=dias)

    datos = yf.download(
        tickers=tickers,
        start=fecha_ini.strftime("%Y-%m-%d"),
        end=fecha_fin.strftime("%Y-%m-%d"),
        auto_adjust=True,
        progress=False,
        threads=True,
        group_by="column",
    )
    if isinstance(datos.columns, pd.MultiIndex) and "Close" in datos.columns.get_level_values(0):
        precios = datos["Close"].copy()
    elif "Close" in datos.columns:
        precios = pd.DataFrame({tickers[0]: datos["Close"]})
    else:
        return pd.DataFrame()
    return precios


def descargar_precios(tickers: List[str], dias=DIAS_HISTORIA) -> pd.DataFrame:
    """Descarga en chunks de CHUNK_SIZE para no saturar yfinance."""
    fecha_fin = date.today()
    fecha_ini = fecha_fin - timedelta(days=dias)
    print(f"\nDescargando precios de {len(tickers)} tickers ({fecha_ini} → {fecha_fin})…")
    print(f"  Procesando en chunks de {CHUNK_SIZE}, pausa {PAUSA_ENTRE_CHUNKS}s entre chunks")

    chunks = [tickers[i:i + CHUNK_SIZE] for i in range(0, len(tickers), CHUNK_SIZE)]
    parciales = []
    for i, chunk in enumerate(chunks, 1):
        print(f"  chunk {i}/{len(chunks)}  ({len(chunk)} tickers)…", end="", flush=True)
        try:
            p = descargar_precios_chunk(chunk, dias)
            if not p.empty:
                parciales.append(p)
                print(f" OK ({len(p.columns)} columnas)")
            else:
                print(" vacío")
        except Exception as e:
            print(f" × error ({e})")
        if i < len(chunks):
            time.sleep(PAUSA_ENTRE_CHUNKS)

    if not parciales:
        raise RuntimeError("Ningún chunk regresó datos. Probablemente yfinance está rate-limited o sin red.")

    # Concatenar por índice (fechas) — algunos chunks pueden tener menos fechas
    precios = pd.concat(parciales, axis=1)
    # Quitar columnas duplicadas (si por error un ticker quedó en dos chunks)
    precios = precios.loc[:, ~precios.columns.duplicated()]

    # ---- FILTRO A: historia mínima ----
    validos_hist = precios.dropna(axis=1, thresh=MIN_DIAS).columns.tolist()
    dropped_hist = len(precios.columns) - len(validos_hist)
    precios = precios[validos_hist]

    # ---- FILTRO B: que SIGA cotizando ----
    hoy = pd.Timestamp(fecha_fin)
    limite = hoy - pd.Timedelta(days=MAX_DIAS_SIN_COTIZAR + 3)

    cotizando = []
    for t in precios.columns:
        ultima = precios[t].dropna().index.max() if precios[t].notna().any() else None
        if ultima is not None and ultima >= limite:
            cotizando.append(t)
    delisted = len(precios.columns) - len(cotizando)
    precios = precios[cotizando]

    # ---- LIMPIEZA ----
    precios = precios.ffill().dropna(axis=0, how="all")

    print(f"\n  ✓ {len(precios.columns)} tickers vigentes · {len(precios)} días")
    print(f"  ✗ {dropped_hist} dropeados por historia insuficiente")
    print(f"  ✗ {delisted} dropeados por parecer delisted")
    return precios


# ============================================================
# 9. METADATA — paralelizada
# ============================================================
_CRYPTO_NOMBRES = {
    "BTC-USD": "Bitcoin", "ETH-USD": "Ethereum", "SOL-USD": "Solana",
    "BNB-USD": "BNB", "XRP-USD": "XRP", "ADA-USD": "Cardano",
    "DOGE-USD": "Dogecoin", "AVAX-USD": "Avalanche", "DOT-USD": "Polkadot",
    "LINK-USD": "Chainlink", "LTC-USD": "Litecoin", "MATIC-USD": "Polygon",
    "TRX-USD": "TRON", "BCH-USD": "Bitcoin Cash", "NEAR-USD": "NEAR Protocol",
    "FIL-USD": "Filecoin", "ATOM-USD": "Cosmos", "ETC-USD": "Ethereum Classic",
    "XLM-USD": "Stellar", "ICP-USD": "Internet Computer", "USDT-USD": "Tether",
    "USDC-USD": "USD Coin", "DAI-USD": "Dai", "WBTC-USD": "Wrapped Bitcoin",
    "SHIB-USD": "Shiba Inu", "PEPE24478-USD": "Pepe",
}


def _info_de(t: str) -> tuple[str, dict]:
    is_mx     = t.endswith(".MX")
    is_etf    = t in ETFS_INDICES
    is_crypto = t.endswith("-USD")
    is_intl   = ("." in t and not is_mx)

    if is_crypto:
        defaults = {
            "nombre":    _CRYPTO_NOMBRES.get(t, t.replace("-USD", "").replace("11419", "").replace("18876", "").replace("21794", "")),
            "sector":    "Criptomoneda",
            "industria": "Criptomoneda",
            "pais":      "Global",
            "moneda":    "USD",
        }
    elif is_intl:
        # Mapeo país por sufijo
        sufijo_pais = {
            ".L":   ("United Kingdom", "GBP"),
            ".DE":  ("Germany", "EUR"),
            ".PA":  ("France", "EUR"),
            ".MC":  ("Spain", "EUR"),
            ".MI":  ("Italy", "EUR"),
            ".SW":  ("Switzerland", "CHF"),
            ".AS":  ("Netherlands", "EUR"),
            ".CO":  ("Denmark", "DKK"),
            ".ST":  ("Sweden", "SEK"),
            ".OL":  ("Norway", "NOK"),
            ".T":   ("Japan", "JPY"),
            ".HK":  ("Hong Kong", "HKD"),
            ".NS":  ("India", "INR"),
            ".KS":  ("South Korea", "KRW"),
            ".TW":  ("Taiwan", "TWD"),
            ".AX":  ("Australia", "AUD"),
            ".SA":  ("Brazil", "BRL"),
        }
        pais, moneda = "International", "USD"
        for suf, (p, m) in sufijo_pais.items():
            if t.endswith(suf):
                pais, moneda = p, m
                break
        defaults = {"nombre": t, "sector": "Internacional", "industria": "Internacional",
                    "pais": pais, "moneda": moneda}
    else:
        defaults = {
            "nombre":    t,
            "sector":    "ETF / Índice" if is_etf else "Desconocido",
            "industria": "ETF / Índice" if is_etf else "Desconocido",
            "pais":      "Mexico"       if is_mx else "United States",
            "moneda":    "MXN"          if is_mx else "USD",
        }

    if is_crypto:
        return t, defaults

    try:
        i = yf.Ticker(t).info or {}
        return t, {
            "nombre":    i.get("longName") or i.get("shortName") or t,
            "sector":    i.get("sector")   or defaults["sector"],
            "industria": i.get("industry") or defaults["industria"],
            "pais":      i.get("country")  or defaults["pais"],
            "moneda":    i.get("currency") or defaults["moneda"],
        }
    except Exception:
        return t, defaults


def descargar_info(tickers: List[str], workers: int = 16) -> dict:
    print(f"\nDescargando metadata ({len(tickers)} tickers, {workers} hilos)…")
    resultado = {}
    completos = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futuros = [ex.submit(_info_de, t) for t in tickers]
        for f in as_completed(futuros):
            try:
                t, i = f.result()
                resultado[t] = i
            except Exception:
                pass
            completos += 1
            if completos % 200 == 0:
                print(f"  {completos}/{len(tickers)}")
    return resultado


# ============================================================
# 10. ENRIQUECER + GUARDAR
# ============================================================
def enriquecer_info(info: dict, precios: pd.DataFrame, recomendadas: set) -> dict:
    for t in list(info.keys()):
        if t in precios.columns:
            ult = precios[t].dropna()
            info[t]["precio_actual"] = round(float(ult.iloc[-1]), 2) if len(ult) else None
        else:
            info[t]["precio_actual"] = None
        info[t]["recomendada"] = t in recomendadas
    return info


def guardar(precios: pd.DataFrame, info: dict):
    carpeta = Path(__file__).parent
    ruta_csv = carpeta / "universo_precios.csv"
    ruta_info = carpeta / "universo_info.json"

    precios.to_csv(ruta_csv)
    with open(ruta_info, "w", encoding="utf-8") as f:
        json.dump(info, f, indent=2, ensure_ascii=False)

    recos = sum(1 for i in info.values() if i.get("recomendada"))
    print("\n" + "=" * 60)
    print(f"  Precios → {ruta_csv}")
    print(f"  Info    → {ruta_info}")
    print(f"  Tickers: {len(precios.columns)} totales · {recos} recomendadas")
    print("=" * 60)


# ============================================================
# 11. MAIN
# ============================================================
def main():
    print("=" * 60)
    print("  Descarga del universo (10K+ tickers)")
    print("=" * 60)

    # Combinamos todas las fuentes
    sp500   = obtener_sp500()
    sp400   = obtener_sp400_midcap()
    sp600   = obtener_sp600_smallcap()
    ndx     = obtener_nasdaq100()
    djia    = obtener_dow_jones()
    russell = obtener_russell1000()
    nasdaq_full = obtener_nasdaqtrader_full()

    universo = sorted(set(
        sp500 + sp400 + sp600 + ndx + djia + russell + nasdaq_full
        + BMV_COMPLETO + ETFS_INDICES + CRYPTO_TICKERS + INTERNACIONALES
    ))
    print(f"\nUniverso inicial deduplicado: {len(universo)} tickers")
    print(f"  ├─ {len(sp500)} S&P 500")
    print(f"  ├─ {len(sp400)} S&P 400 MidCap")
    print(f"  ├─ {len(sp600)} S&P 600 SmallCap")
    print(f"  ├─ {len(ndx)} NASDAQ 100")
    print(f"  ├─ {len(russell)} Russell 1000")
    print(f"  ├─ {len(nasdaq_full)} NASDAQ Trader full list")
    print(f"  ├─ {len(BMV_COMPLETO)} BMV México")
    print(f"  ├─ {len(ETFS_INDICES)} ETFs/Índices")
    print(f"  ├─ {len(INTERNACIONALES)} Internacionales")
    print(f"  └─ {len(CRYPTO_TICKERS)} Cripto")

    # Recomendadas
    recomendadas = set(
        SP500_RECOMENDADAS + IPC_RECOMENDADAS + ETFS_INDICES + CRYPTO_RECOMENDADAS
    )

    precios = descargar_precios(universo)
    validos = list(precios.columns)

    info = descargar_info(validos)
    info = {t: info[t] for t in validos if t in info}
    info = enriquecer_info(info, precios, recomendadas)

    guardar(precios, info)


if __name__ == "__main__":
    main()
