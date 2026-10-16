FROM python:3.12-slim
WORKDIR /app/tools/seed
RUN pip install --no-cache-dir httpx==0.28.1 "psycopg[binary]==3.2.3"
COPY data/geo /app/data/geo
COPY tools/seed ./
ENV GEO_PATH=/app/data/geo/markets.json PYTHONUNBUFFERED=1
CMD ["python", "seed.py"]
