"""
sectores.py — Resolver de sectores para tickers que vienen como
"Desconocido" desde yfinance.

Mapping curado para los ~300 tickers más comunes (S&P 500 top, IPC MX,
ETFs líderes, cripto). Para el resto, aplica heurísticas por sufijo y
patrones de ticker.

Uso:
    from sectores import resolver_sector
    sector = resolver_sector("AAPL", info_actual.get("sector"))
"""
from __future__ import annotations
from typing import Optional


# ─────────────────────────────────────────────────────────────────
# Mapping específico — sector real de cada ticker
# ─────────────────────────────────────────────────────────────────
SECTORES_HARDCODED = {
    # Mega-caps tech / Communication
    "AAPL": "Technology", "MSFT": "Technology", "NVDA": "Technology",
    "GOOGL": "Communication Services", "GOOG": "Communication Services",
    "META": "Communication Services", "AMZN": "Consumer Cyclical",
    "TSLA": "Consumer Cyclical", "AVGO": "Technology", "ORCL": "Technology",
    "CRM": "Technology", "ADBE": "Technology", "CSCO": "Technology",
    "INTC": "Technology", "AMD": "Technology", "QCOM": "Technology",
    "TXN": "Technology", "MU": "Technology", "AMAT": "Technology",
    "LRCX": "Technology", "KLAC": "Technology", "PANW": "Technology",
    "SNPS": "Technology", "CDNS": "Technology", "INTU": "Technology",
    "NOW": "Technology", "IBM": "Technology", "HPQ": "Technology",
    "DELL": "Technology", "WDAY": "Technology", "TEAM": "Technology",
    "CRWD": "Technology", "DDOG": "Technology", "SNOW": "Technology",
    "MDB": "Technology", "NET": "Technology", "ZS": "Technology",
    "OKTA": "Technology", "FTNT": "Technology", "MSI": "Technology",
    "ANET": "Technology", "VRSN": "Technology", "FSLR": "Technology",
    "ENPH": "Technology", "WDC": "Technology", "STX": "Technology",
    "ON": "Technology", "MCHP": "Technology", "MRVL": "Technology",
    "MPWR": "Technology", "ADI": "Technology", "GLW": "Technology",
    "NTAP": "Technology", "FFIV": "Technology", "AKAM": "Technology",
    "EPAM": "Technology", "GEN": "Technology", "JNPR": "Technology",
    "ZBRA": "Technology",
    # Communication Services
    "NFLX": "Communication Services", "DIS": "Communication Services",
    "CMCSA": "Communication Services", "T": "Communication Services",
    "VZ": "Communication Services", "TMUS": "Communication Services",
    "CHTR": "Communication Services", "PARA": "Communication Services",
    "WBD": "Communication Services", "EA": "Communication Services",
    "TTWO": "Communication Services", "MTCH": "Communication Services",
    "PINS": "Communication Services", "SNAP": "Communication Services",
    "ROKU": "Communication Services", "SPOT": "Communication Services",
    "OMC": "Communication Services", "IPG": "Communication Services",
    "DISH": "Communication Services", "FOX": "Communication Services",
    "FOXA": "Communication Services", "NWS": "Communication Services",
    "NWSA": "Communication Services",
    # Financials
    "JPM": "Financial Services", "BAC": "Financial Services",
    "WFC": "Financial Services", "C": "Financial Services",
    "GS": "Financial Services", "MS": "Financial Services",
    "BLK": "Financial Services", "SCHW": "Financial Services",
    "AXP": "Financial Services", "USB": "Financial Services",
    "PNC": "Financial Services", "TFC": "Financial Services",
    "COF": "Financial Services", "BK": "Financial Services",
    "STT": "Financial Services", "FITB": "Financial Services",
    "CFG": "Financial Services", "RF": "Financial Services",
    "HBAN": "Financial Services", "MTB": "Financial Services",
    "KEY": "Financial Services", "ZION": "Financial Services",
    "CMA": "Financial Services", "AIG": "Financial Services",
    "MET": "Financial Services", "PRU": "Financial Services",
    "TRV": "Financial Services", "ALL": "Financial Services",
    "PGR": "Financial Services", "AFL": "Financial Services",
    "CB": "Financial Services", "AON": "Financial Services",
    "MMC": "Financial Services", "MCO": "Financial Services",
    "SPGI": "Financial Services", "MSCI": "Financial Services",
    "ICE": "Financial Services", "CME": "Financial Services",
    "CBOE": "Financial Services", "NDAQ": "Financial Services",
    "V": "Financial Services", "MA": "Financial Services",
    "PYPL": "Financial Services", "FIS": "Financial Services",
    "FISV": "Financial Services", "GPN": "Financial Services",
    "BRK-A": "Financial Services", "BRK-B": "Financial Services",
    "DFS": "Financial Services", "SYF": "Financial Services",
    # Healthcare
    "UNH": "Healthcare", "JNJ": "Healthcare", "LLY": "Healthcare",
    "PFE": "Healthcare", "MRK": "Healthcare", "ABBV": "Healthcare",
    "TMO": "Healthcare", "ABT": "Healthcare", "DHR": "Healthcare",
    "BMY": "Healthcare", "AMGN": "Healthcare", "GILD": "Healthcare",
    "CVS": "Healthcare", "MDT": "Healthcare", "ELV": "Healthcare",
    "ISRG": "Healthcare", "REGN": "Healthcare", "VRTX": "Healthcare",
    "ZTS": "Healthcare", "BSX": "Healthcare", "SYK": "Healthcare",
    "CI": "Healthcare", "HUM": "Healthcare", "CNC": "Healthcare",
    "EW": "Healthcare", "DXCM": "Healthcare", "IDXX": "Healthcare",
    "BIIB": "Healthcare", "ILMN": "Healthcare", "MRNA": "Healthcare",
    "BNTX": "Healthcare", "BAX": "Healthcare", "BDX": "Healthcare",
    "WAT": "Healthcare", "MTD": "Healthcare", "RMD": "Healthcare",
    "STE": "Healthcare", "HOLX": "Healthcare", "IQV": "Healthcare",
    "LH": "Healthcare", "DGX": "Healthcare", "MCK": "Healthcare",
    "ABC": "Healthcare", "COR": "Healthcare", "CAH": "Healthcare",
    "HCA": "Healthcare", "CRL": "Healthcare", "WST": "Healthcare",
    "HSIC": "Healthcare", "PODD": "Healthcare", "TFX": "Healthcare",
    "ALGN": "Healthcare", "MOH": "Healthcare",
    # Consumer Cyclical
    "HD": "Consumer Cyclical", "MCD": "Consumer Cyclical",
    "NKE": "Consumer Cyclical", "SBUX": "Consumer Cyclical",
    "BKNG": "Consumer Cyclical", "TJX": "Consumer Cyclical",
    "LOW": "Consumer Cyclical", "ABNB": "Consumer Cyclical",
    "MAR": "Consumer Cyclical", "HLT": "Consumer Cyclical",
    "CMG": "Consumer Cyclical", "ORLY": "Consumer Cyclical",
    "AZO": "Consumer Cyclical", "GM": "Consumer Cyclical",
    "F": "Consumer Cyclical", "RIVN": "Consumer Cyclical",
    "LCID": "Consumer Cyclical", "TGT": "Consumer Cyclical",
    "DG": "Consumer Cyclical", "DLTR": "Consumer Cyclical",
    "ROST": "Consumer Cyclical", "BBY": "Consumer Cyclical",
    "EBAY": "Consumer Cyclical", "ETSY": "Consumer Cyclical",
    "DASH": "Consumer Cyclical", "UBER": "Consumer Cyclical",
    "LYFT": "Consumer Cyclical", "DPZ": "Consumer Cyclical",
    "QSR": "Consumer Cyclical", "YUM": "Consumer Cyclical",
    "MGM": "Consumer Cyclical", "WYNN": "Consumer Cyclical",
    "LVS": "Consumer Cyclical", "CCL": "Consumer Cyclical",
    "RCL": "Consumer Cyclical", "NCLH": "Consumer Cyclical",
    "EXPE": "Consumer Cyclical", "TRIP": "Consumer Cyclical",
    "RL": "Consumer Cyclical", "TPR": "Consumer Cyclical",
    "CPRI": "Consumer Cyclical", "VFC": "Consumer Cyclical",
    "LULU": "Consumer Cyclical", "DECK": "Consumer Cyclical",
    "HBI": "Consumer Cyclical", "PVH": "Consumer Cyclical",
    "GPS": "Consumer Cyclical", "ANF": "Consumer Cyclical",
    "URBN": "Consumer Cyclical",
    # Consumer Defensive
    "WMT": "Consumer Defensive", "PG": "Consumer Defensive",
    "COST": "Consumer Defensive", "PEP": "Consumer Defensive",
    "KO": "Consumer Defensive", "MDLZ": "Consumer Defensive",
    "MO": "Consumer Defensive", "PM": "Consumer Defensive",
    "CL": "Consumer Defensive", "GIS": "Consumer Defensive",
    "K": "Consumer Defensive", "HSY": "Consumer Defensive",
    "MNST": "Consumer Defensive", "KDP": "Consumer Defensive",
    "STZ": "Consumer Defensive", "TAP": "Consumer Defensive",
    "DEO": "Consumer Defensive", "EL": "Consumer Defensive",
    "CHD": "Consumer Defensive", "CLX": "Consumer Defensive",
    "KMB": "Consumer Defensive", "KHC": "Consumer Defensive",
    "CPB": "Consumer Defensive", "CAG": "Consumer Defensive",
    "HRL": "Consumer Defensive", "MKC": "Consumer Defensive",
    "SJM": "Consumer Defensive", "TSN": "Consumer Defensive",
    "ADM": "Consumer Defensive", "BG": "Consumer Defensive",
    "SYY": "Consumer Defensive", "USFD": "Consumer Defensive",
    "WBA": "Consumer Defensive", "KR": "Consumer Defensive",
    # Energy
    "XOM": "Energy", "CVX": "Energy", "COP": "Energy",
    "EOG": "Energy", "OXY": "Energy", "MPC": "Energy",
    "PSX": "Energy", "VLO": "Energy", "SLB": "Energy",
    "PXD": "Energy", "HES": "Energy", "DVN": "Energy",
    "FANG": "Energy", "WMB": "Energy", "KMI": "Energy",
    "OKE": "Energy", "EQT": "Energy", "TRGP": "Energy",
    "HAL": "Energy", "BKR": "Energy", "CTRA": "Energy",
    "MRO": "Energy", "APA": "Energy", "OVV": "Energy",
    "NOV": "Energy", "FTI": "Energy",
    # Industrials
    "GE": "Industrials", "RTX": "Industrials", "BA": "Industrials",
    "HON": "Industrials", "UNP": "Industrials", "UPS": "Industrials",
    "CAT": "Industrials", "DE": "Industrials", "LMT": "Industrials",
    "GD": "Industrials", "NOC": "Industrials", "MMM": "Industrials",
    "EMR": "Industrials", "ETN": "Industrials", "ITW": "Industrials",
    "PH": "Industrials", "FDX": "Industrials", "CSX": "Industrials",
    "NSC": "Industrials", "WM": "Industrials", "RSG": "Industrials",
    "ROP": "Industrials", "JCI": "Industrials", "OTIS": "Industrials",
    "CARR": "Industrials", "IR": "Industrials", "TT": "Industrials",
    "PCAR": "Industrials", "PWR": "Industrials", "FAST": "Industrials",
    "GWW": "Industrials", "MAS": "Industrials", "ALLE": "Industrials",
    "AME": "Industrials", "DOV": "Industrials", "FTV": "Industrials",
    "XYL": "Industrials", "RHI": "Industrials", "URI": "Industrials",
    "PAYX": "Industrials", "AAL": "Industrials", "DAL": "Industrials",
    "UAL": "Industrials", "LUV": "Industrials", "ALK": "Industrials",
    "JBHT": "Industrials", "EXPD": "Industrials", "CHRW": "Industrials",
    "ODFL": "Industrials", "XPO": "Industrials", "MAS": "Industrials",
    # Real Estate
    "AMT": "Real Estate", "PLD": "Real Estate", "EQIX": "Real Estate",
    "CCI": "Real Estate", "PSA": "Real Estate", "WELL": "Real Estate",
    "DLR": "Real Estate", "O": "Real Estate", "SPG": "Real Estate",
    "VICI": "Real Estate", "CSGP": "Real Estate", "AVB": "Real Estate",
    "EQR": "Real Estate", "EXR": "Real Estate", "MAA": "Real Estate",
    "ESS": "Real Estate", "INVH": "Real Estate", "UDR": "Real Estate",
    "CPT": "Real Estate", "ARE": "Real Estate", "BXP": "Real Estate",
    "VTR": "Real Estate", "PEAK": "Real Estate", "DOC": "Real Estate",
    "REG": "Real Estate", "FRT": "Real Estate", "KIM": "Real Estate",
    "SLG": "Real Estate", "HST": "Real Estate", "AIV": "Real Estate",
    # Utilities
    "NEE": "Utilities", "SO": "Utilities", "DUK": "Utilities",
    "AEP": "Utilities", "SRE": "Utilities", "D": "Utilities",
    "EXC": "Utilities", "XEL": "Utilities", "ED": "Utilities",
    "WEC": "Utilities", "ETR": "Utilities", "ES": "Utilities",
    "PEG": "Utilities", "AWK": "Utilities", "DTE": "Utilities",
    "PPL": "Utilities", "AEE": "Utilities", "FE": "Utilities",
    "EIX": "Utilities", "PCG": "Utilities", "CMS": "Utilities",
    "CNP": "Utilities", "ATO": "Utilities", "LNT": "Utilities",
    "EVRG": "Utilities", "PNW": "Utilities", "NRG": "Utilities",
    "VST": "Utilities", "AES": "Utilities", "NI": "Utilities",
    # Basic Materials
    "LIN": "Basic Materials", "SHW": "Basic Materials",
    "APD": "Basic Materials", "FCX": "Basic Materials",
    "ECL": "Basic Materials", "NEM": "Basic Materials",
    "DD": "Basic Materials", "DOW": "Basic Materials",
    "PPG": "Basic Materials", "ALB": "Basic Materials",
    "VMC": "Basic Materials", "MLM": "Basic Materials",
    "STLD": "Basic Materials", "NUE": "Basic Materials",
    "X": "Basic Materials", "CLF": "Basic Materials",
    "AA": "Basic Materials", "RS": "Basic Materials",
    "EMN": "Basic Materials", "LYB": "Basic Materials",
    "CF": "Basic Materials", "MOS": "Basic Materials",
    "FMC": "Basic Materials", "IFF": "Basic Materials",
    "AVTR": "Basic Materials", "PKG": "Basic Materials",
    "IP": "Basic Materials", "WRK": "Basic Materials",
    "BLL": "Basic Materials", "AMCR": "Basic Materials",
    "SEE": "Basic Materials", "GOLD": "Basic Materials",
    "AEM": "Basic Materials", "FNV": "Basic Materials",
    "WPM": "Basic Materials",
}

# Mexicano (BMV) — sectores reales
SECTORES_MX = {
    "WALMEX.MX": "Consumer Defensive", "FEMSAUBD.MX": "Consumer Defensive",
    "AC.MX": "Consumer Defensive", "KOFUBL.MX": "Consumer Defensive",
    "BIMBOA.MX": "Consumer Defensive", "GRUMAB.MX": "Consumer Defensive",
    "KIMBERA.MX": "Consumer Defensive", "CUERVO.MX": "Consumer Defensive",
    "HERDEZ.MX": "Consumer Defensive", "LALAB.MX": "Consumer Defensive",
    "GFNORTEO.MX": "Financial Services", "BBAJIOO.MX": "Financial Services",
    "GFINBURO.MX": "Financial Services", "BSMXB.MX": "Financial Services",
    "BOLSAA.MX": "Financial Services", "GENTERA.MX": "Financial Services",
    "MONEXB.MX": "Financial Services", "INVEXA.MX": "Financial Services",
    "Q.MX": "Financial Services",
    "AMXB.MX": "Communication Services", "TLEVISACPO.MX": "Communication Services",
    "MEGACPO.MX": "Communication Services", "TVAZTCPO.MX": "Communication Services",
    "AXTELCPO.MX": "Communication Services",
    "GMEXICOB.MX": "Basic Materials", "CEMEXCPO.MX": "Basic Materials",
    "PE&OLES.MX": "Basic Materials", "ORBIA.MX": "Basic Materials",
    "GCC.MX": "Basic Materials", "ALPEKA.MX": "Basic Materials",
    "MFRISCOA-1.MX": "Basic Materials", "VITROA.MX": "Basic Materials",
    "ALFAA.MX": "Industrials", "ALSEA.MX": "Consumer Cyclical",
    "ELEKTRA.MX": "Consumer Cyclical", "LIVEPOLC-1.MX": "Consumer Cyclical",
    "CHDRAUIB.MX": "Consumer Defensive", "SORIANAB.MX": "Consumer Defensive",
    "GAPB.MX": "Industrials", "ASURB.MX": "Industrials", "OMAB.MX": "Industrials",
    "PINFRA.MX": "Industrials", "VOLARA.MX": "Industrials",
    "GCARSOA1.MX": "Industrials", "NEMAKA.MX": "Industrials",
    "GMD.MX": "Industrials", "ARA.MX": "Real Estate",
    "VESTA.MX": "Real Estate", "FUNO11.MX": "Real Estate",
    "FIBRAMQ12.MX": "Real Estate", "FIBRAPL14.MX": "Real Estate",
    "FMTY14.MX": "Real Estate", "FIHO12.MX": "Real Estate",
    "TERRA13.MX": "Real Estate", "DANHOS13.MX": "Real Estate",
    "FNOVA17.MX": "Real Estate", "STORAGE18.MX": "Real Estate",
    "FCFE18.MX": "Real Estate", "FIBRAHD15.MX": "Real Estate",
    "MEDICAB.MX": "Healthcare", "LABB.MX": "Healthcare",
    "RA.MX": "Healthcare",
    "GISSAA.MX": "Industrials", "GPHB.MX": "Consumer Defensive",
    "HCITY.MX": "Consumer Cyclical", "HOGAR-B.MX": "Consumer Cyclical",
    "ICA.MX": "Industrials", "ICHB.MX": "Industrials",
    "IDEALB-1.MX": "Industrials",
    "NAFTRAC.MX": "ETF / Índice", "MEXTRAC.MX": "ETF / Índice",
}

# ETFs - clasificados por estrategia (más útil que "Desconocido")
SECTORES_ETF = {
    # Broad market US
    "SPY": "ETF · S&P 500", "VOO": "ETF · S&P 500", "IVV": "ETF · S&P 500",
    "VTI": "ETF · Total US Market", "ITOT": "ETF · Total US Market",
    "SCHB": "ETF · Total US Market", "SCHX": "ETF · Total US Market",
    "VTV": "ETF · Value US", "SCHD": "ETF · Dividend US",
    "VYM": "ETF · Dividend US", "VUG": "ETF · Growth US",
    "SCHG": "ETF · Growth US",
    "QQQ": "ETF · NASDAQ-100", "DIA": "ETF · Dow Jones",
    "IWM": "ETF · Small Cap US", "IJR": "ETF · Small Cap US",
    "MDY": "ETF · Mid Cap US", "IJH": "ETF · Mid Cap US",
    # Sectoriales US
    "XLK": "ETF · Sector Tech", "VGT": "ETF · Sector Tech",
    "XLF": "ETF · Sector Financiero", "VFH": "ETF · Sector Financiero",
    "XLV": "ETF · Sector Salud", "VHT": "ETF · Sector Salud",
    "XLE": "ETF · Sector Energía", "VDE": "ETF · Sector Energía",
    "XLY": "ETF · Sector Consumo Cíclico", "VCR": "ETF · Sector Consumo Cíclico",
    "XLP": "ETF · Sector Consumo Defensivo", "VDC": "ETF · Sector Consumo Defensivo",
    "XLI": "ETF · Sector Industrial", "VIS": "ETF · Sector Industrial",
    "XLU": "ETF · Sector Utilities", "VPU": "ETF · Sector Utilities",
    "XLB": "ETF · Sector Materiales", "VAW": "ETF · Sector Materiales",
    "XLRE": "ETF · Real Estate", "VNQ": "ETF · Real Estate",
    "XLC": "ETF · Sector Communication", "VOX": "ETF · Sector Communication",
    "SOXX": "ETF · Semiconductores", "SMH": "ETF · Semiconductores",
    "FDN": "ETF · Internet US", "HACK": "ETF · Cybersecurity",
    "CIBR": "ETF · Cybersecurity",
    # Internacionales
    "VEA": "ETF · Desarrollados ex-USA", "EFA": "ETF · Desarrollados ex-USA",
    "IEFA": "ETF · Desarrollados ex-USA", "VEU": "ETF · Global ex-USA",
    "VWO": "ETF · Emergentes", "EEM": "ETF · Emergentes",
    "IEMG": "ETF · Emergentes", "ACWI": "ETF · Global",
    "EWJ": "ETF · Japón", "EWZ": "ETF · Brasil",
    "EWG": "ETF · Alemania", "EWU": "ETF · Reino Unido",
    "INDA": "ETF · India", "MCHI": "ETF · China",
    "FXI": "ETF · China", "ASHR": "ETF · China A-Shares",
    "EWY": "ETF · Korea", "EWT": "ETF · Taiwán",
    "EWQ": "ETF · Francia", "EWP": "ETF · España",
    "EWI": "ETF · Italia",
    # Bonos
    "AGG": "ETF · Bonos Total", "BND": "ETF · Bonos Total",
    "TLT": "ETF · Bonos LT US", "IEF": "ETF · Bonos MT US",
    "SHY": "ETF · Bonos CT US", "BSV": "ETF · Bonos CT US",
    "LQD": "ETF · Bonos Corp Investment Grade", "HYG": "ETF · Bonos High Yield",
    "JNK": "ETF · Bonos High Yield", "MUB": "ETF · Bonos Municipales",
    "TIP": "ETF · TIPS Inflación",
    # Commodities
    "GLD": "ETF · Oro", "IAU": "ETF · Oro",
    "SLV": "ETF · Plata", "USO": "ETF · Petróleo",
    "UNG": "ETF · Gas Natural", "DBC": "ETF · Commodities Diversificado",
    "GDX": "ETF · Mineras de Oro", "GDXJ": "ETF · Mineras Junior",
    "PPLT": "ETF · Platino", "PALL": "ETF · Paladio",
    # Crypto ETFs
    "BITO": "ETF · Bitcoin Futures", "FBTC": "ETF · Bitcoin Spot",
    "IBIT": "ETF · Bitcoin Spot", "ARKB": "ETF · Bitcoin Spot",
    "GBTC": "ETF · Bitcoin Spot",
    # Temáticos
    "ARKK": "ETF · Innovación", "ARKW": "ETF · Internet Next-Gen",
    "ARKG": "ETF · Genómica", "ARKF": "ETF · Fintech",
    "ARKQ": "ETF · Robótica/AI", "ARKX": "ETF · Espacio",
    "PRNT": "ETF · 3D Printing", "ICLN": "ETF · Energía Limpia",
    "TAN": "ETF · Solar", "LIT": "ETF · Litio/Baterías",
    "URA": "ETF · Uranio", "ROBO": "ETF · Robótica/AI",
    "BOTZ": "ETF · Robótica/AI",
}

# Crypto — mismo "sector" para todas pero más amigable
SECTORES_CRYPTO_OVERRIDE = "Criptomoneda"


# ─────────────────────────────────────────────────────────────────
# Resolver con cascada de fallbacks
# ─────────────────────────────────────────────────────────────────
def resolver_sector(ticker: str, sector_actual: Optional[str] = None) -> str:
    """Resuelve el sector de un ticker. Nunca devuelve "Desconocido"."""
    # Si tenemos un sector específico válido, mantenerlo
    if sector_actual and sector_actual not in ("Desconocido", "", None, "ETF / Índice", "Internacional"):
        return sector_actual

    # Lookup en mappings curados
    if ticker in SECTORES_HARDCODED:
        return SECTORES_HARDCODED[ticker]
    if ticker in SECTORES_MX:
        return SECTORES_MX[ticker]
    if ticker in SECTORES_ETF:
        return SECTORES_ETF[ticker]

    # Heurísticas por patrón
    if ticker.endswith("-USD"):
        return SECTORES_CRYPTO_OVERRIDE

    if ticker.endswith(".MX"):
        # Si era un ETF / Índice genérico, mantenemos
        if sector_actual == "ETF / Índice":
            return "ETF MX"
        return "Acciones México"

    # Sufijos internacionales — ya teníamos info por sufijo
    sufijos_intl = {
        ".L": "Acciones Reino Unido", ".DE": "Acciones Alemania",
        ".PA": "Acciones Francia", ".MC": "Acciones España",
        ".MI": "Acciones Italia", ".SW": "Acciones Suiza",
        ".AS": "Acciones Holanda", ".CO": "Acciones Dinamarca",
        ".ST": "Acciones Suecia", ".OL": "Acciones Noruega",
        ".T": "Acciones Japón", ".HK": "Acciones Hong Kong",
        ".NS": "Acciones India", ".KS": "Acciones Korea",
        ".TW": "Acciones Taiwán", ".AX": "Acciones Australia",
        ".SA": "Acciones Brasil",
    }
    for suf, label in sufijos_intl.items():
        if ticker.endswith(suf):
            return label

    # ETFs USA con patrones obvios
    upper = ticker.upper()
    if any(upper.startswith(p) for p in ("V", "VT", "VO", "VG", "VH", "VC", "VD")) and len(upper) <= 4:
        return "ETF · Vanguard"
    if upper.startswith(("XL", "SP", "SCH", "ARK")) and len(upper) <= 5:
        return "ETF · Diversificado"
    if upper.startswith("I") and len(upper) <= 4:
        return "ETF · iShares"

    # Si era ETF/Índice genérico sin más info
    if sector_actual == "ETF / Índice":
        return "ETF · Otro"

    return "Otros"


def patch_info(info_dict: dict) -> dict:
    """Itera un dict {ticker: {nombre, sector, ...}} y reemplaza
    sectores 'Desconocido' o vacíos con el resolver. Devuelve el mismo
    dict (mutado in-place para eficiencia)."""
    for t, m in info_dict.items():
        if not isinstance(m, dict):
            continue
        sec = resolver_sector(t, m.get("sector"))
        if sec != m.get("sector"):
            m["sector"] = sec
    return info_dict
