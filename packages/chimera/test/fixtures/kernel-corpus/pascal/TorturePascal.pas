unit TorturePascal;

{ Kernel-parity torture fixture: declarations (unit/uses/const/type),
  visibility sections, inheritance, static class functions, properties,
  implementation defProc bodies, chained and paren-less calls, and the
  pascal function-as-value / value-reference cases. }

interface

uses
  SysUtils, Classes;

const
  MaxItems = 10;
  MinItems = 1;

type
  TColor = (Red, Green, Blue);

  TPoint = record
    X, Y: Integer;
  end;

  TAlias = Integer;

  IWidget = interface
    procedure Draw;
    function Name: string;
  end;

  TBase = class
  public
    procedure Hello;
  end;

  TWidget = class(TBase, IWidget)
  private
    FName: string;
    FCount: Integer;
  protected
    procedure SetName(const Value: string);
  public
    const
      DefName = 'x';
    constructor Create;
    destructor Destroy; override;
    class function GetInstance: TWidget;
    procedure Hello; override;
    function Name: string;
    property Title: string read FName write SetName;
  published
    property Count: Integer read FCount;
  end;

implementation

constructor TWidget.Create;
begin
  FName := DefName;
  FCount := MinItems;
end;

destructor TWidget.Destroy;
begin
  inherited;
end;

class function TWidget.GetInstance: TWidget;
begin
  Result := TWidget.Create;
end;

{ Assigns the display name. }
procedure TWidget.SetName(const Value: string);
begin
  FName := Value;
  RegisterHandler(@OnFire);
  OnFire := Handler;
end;

procedure TWidget.Hello;
var
  x: Integer;
begin
  x := MaxItems;
  WriteLn(x);
  Self.SetName('a');
  TWidget.GetInstance().Hello;
  TWidget.GetInstance.Hello;
  if x > 0 then WriteLn('pos');
end;

function TWidget.Name: string;
begin
  Result := FName;
end;

procedure UseConst;
begin
  WriteLn(MaxItems);
end;

procedure FreeHelper(a: Integer);
begin
  WriteLn(a);
end;

initialization
  FreeHelper(1);

end.